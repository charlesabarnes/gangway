/**
 * The `mcp` surface (§10.2, ADR-0019): `POST https://mcp.<base>/`, Streamable HTTP, served
 * stateless by the MCP SDK's `createMcpHandler` -- the 2026-07-28 revision, and the 2025
 * handshake for older clients. A fresh server per request, closed over that request's actor.
 *
 * Only a bearer credential, never the session cookie: nothing a browser sends by itself
 * may reach a tool. A request that carries an `Origin` is refused outright -- the clients
 * are CLIs and servers, and a browser page (a hostile preview included) has no business here.
 *
 * Every response is an SSE stream with a keepalive comment every 15 s: `deploy` blocks for
 * minutes, and Nginx Proxy Manager's 60 s read timeout and the listener's idle timeout
 * would otherwise cut it. `dropAll()` ends every open stream at once: §10.5, turning MCP
 * off "drops in-flight sessions", not only new ones -- those 404 in the dispatcher.
 */
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import type { Actor, TokenVerifier } from "../auth/actor.ts";
import type { AppEnv } from "./env.ts";
import { errorHandler, problemResponse } from "./problem.ts";
import { forbidden, notFound, unauthorized } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { SurfaceHandler } from "../net/dispatch.ts";
import { ulid } from "../util/ulid.ts";
import type { Tools } from "../mcp/tools.ts";

const BEARER = /^Bearer\s+(\S+)$/i;

export type McpSurfaceDeps = {
  tools: Tools;
  verifyToken: TokenVerifier;
  logger: Logger;
  /** `WWW-Authenticate` on a 401. From slice G on it points at the protected-resource metadata. */
  challenge?: (() => string) | undefined;
  /** Extra routes on the surface, registered before the catch-all (the OAuth metadata, ADR-0020). */
  extend?: ((app: Hono<AppEnv>) => void) | undefined;
};

type Live = { abort: AbortController };

export class McpSurface {
  readonly #d: McpSurfaceDeps;
  readonly #mcp: McpHttpHandler;
  readonly #app: Hono<AppEnv>;
  readonly #live = new Set<Live>();

  constructor(d: McpSurfaceDeps) {
    this.#d = d;
    this.#mcp = createMcpHandler(
      (ctx) => {
        const extra = ctx.authInfo?.extra as { actor: Actor; signal: AbortSignal } | undefined;
        if (!extra) throw new Error("an MCP request reached the factory without an actor");
        return d.tools.server({ actor: extra.actor, signal: extra.signal });
      },
      { responseMode: "sse", keepAliveMs: 15_000, onerror: (err) => d.logger.warn("mcp request rejected", { err: err.message }) },
    );

    const app = new Hono<AppEnv>();
    app.use(async (c, next) => { c.set("requestId", ulid()); await next(); });
    app.onError(errorHandler(d.logger));
    d.extend?.(app);
    app.on(["GET", "DELETE"], "/", () => new Response("Method not allowed.", { status: 405, headers: { allow: "POST" } }));
    app.post("/", (c) => this.#serve(c.req.raw, c));
    app.all("*", (c) => problemResponse(c, notFound(`no such resource: ${c.req.path}`)));
    this.#app = app;
  }

  handler(): SurfaceHandler {
    return (req, ctx) => this.#app.fetch(req, { surface: "mcp", clientIp: ctx.clientIp });
  }

  /** In-flight MCP responses right now. */
  get open(): number {
    return this.#live.size;
  }

  /** §10.5: MCP switched off. Every open stream ends and every waiting tool gives up. */
  dropAll(): void {
    for (const l of this.#live) l.abort.abort();
    this.#live.clear();
  }

  async #serve(req: Request, c: Context<AppEnv>): Promise<Response> {
    if (req.headers.has("origin")) return problemResponse(c, forbidden("browser requests are not accepted on the MCP surface"));

    const header = req.headers.get("authorization");
    const presented = header ? BEARER.exec(header)?.[1] : undefined;
    const actor = presented ? await this.#d.verifyToken(presented) : null;
    if (!actor) {
      return problemResponse(c, unauthorized(), { "www-authenticate": this.#d.challenge?.() ?? 'Bearer realm="gangway"' });
    }

    const live: Live = { abort: new AbortController() };
    this.#live.add(live);
    let res: Response;
    try {
      res = await this.#mcp.fetch(req, { authInfo: { token: "[redacted]", clientId: "gangway", scopes: [], extra: { actor, signal: live.abort.signal } } });
    } catch (err) {
      this.#live.delete(live);
      throw err;
    }
    if (!res.body) { this.#live.delete(live); return res; }
    return new Response(this.#droppable(res.body, live), { status: res.status, headers: res.headers });
  }

  /** The SDK's stream, ended by us when MCP is switched off. */
  #droppable(body: ReadableStream<Uint8Array>, live: Live): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const done = () => { this.#live.delete(live); };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        live.abort.signal.addEventListener("abort", () => {
          done();
          reader.cancel("the MCP surface was switched off").catch(() => {});
          try { controller.error(new Error("the MCP surface was switched off")); } catch { /* already closed */ }
        }, { once: true });
      },
      pull: async (controller) => {
        try {
          const { done: end, value } = await reader.read();
          if (end) { done(); controller.close(); } else controller.enqueue(value);
        } catch (err) {
          done();
          try { controller.error(err); } catch { /* already errored */ }
        }
      },
      cancel: (reason) => { done(); return reader.cancel(reason); },
    });
  }
}
