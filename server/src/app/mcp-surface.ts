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
import { SCOPE_PERMISSIONS, type Permission, type Scope } from "../../../shared/src/permissions.ts";
import { can, type Actor, type TokenVerifier } from "../auth/actor.ts";
import { isOAuthActor } from "../oauth/server.ts";
import type { AppEnv } from "./env.ts";
import { errorHandler, problemResponse } from "./problem.ts";
import { forbidden, notFound, unauthorized } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { SurfaceHandler } from "../net/dispatch.ts";
import { ulid } from "../util/ulid.ts";
import { TOOL_PERMISSIONS, type Tools } from "../mcp/tools.ts";

const BEARER = /^Bearer\s+(\S+)$/i;

export type McpSurfaceDeps = {
  tools: Tools;
  /** gw_ tokens, the env token, and (ADR-0020) OAuth access tokens -- which nothing else accepts. */
  verifyToken: TokenVerifier;
  logger: Logger;
  /**
   * ADR-0020. Present and `available()`: the protected-resource metadata is served, a 401
   * points at it, and an OAuth grant missing a scope gets a step-up 403. Unavailable (the
   * UI is off, so there is no consent page): bearer tokens only, and nothing advertises OAuth.
   */
  oauth?: {
    available: () => boolean;
    /** `https://mcp.<base>` */
    resource: () => string;
    resourceMetadata: () => Record<string, unknown>;
  } | undefined;
};

const SCOPE_FOR: Record<Permission, Scope | undefined> = Object.fromEntries(
  (["read", "deploy"] as const).flatMap((s) => SCOPE_PERMISSIONS[s].map((p) => [p, s] as const)).reverse(),
) as Record<Permission, Scope | undefined>;

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
    // RFC 9728. The resource has no path, so the root well-known URL is the one (and a
    // client that appends the empty path gets it too).
    app.get("/.well-known/oauth-protected-resource", (c) => this.#prm(c));
    app.get("/.well-known/oauth-protected-resource/", (c) => this.#prm(c));
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

  #oauthOn(): boolean {
    return this.#d.oauth?.available() === true;
  }

  #prm(c: Context<AppEnv>): Response {
    if (!this.#oauthOn()) return problemResponse(c, notFound(`no such resource: ${c.req.path}`));
    return c.json(this.#d.oauth!.resourceMetadata(), 200, { "cache-control": "public, max-age=300" });
  }

  #challenge(extra = ""): string {
    if (!this.#oauthOn()) return 'Bearer realm="gangway"';
    return `Bearer resource_metadata="${this.#d.oauth!.resource()}/.well-known/oauth-protected-resource", scope="read deploy"${extra}`;
  }

  /**
   * The step-up (MCP authorization, "insufficient_scope"): an OAuth grant whose scopes do
   * not cover the tool gets an HTTP 403 naming the scope, which a client answers by asking
   * the user again. A gw_ token has no one to ask; its refusal stays a readable tool error.
   */
  async #stepUp(req: Request, actor: Actor): Promise<Scope | null> {
    if (!isOAuthActor(actor)) return null;
    let body: unknown;
    try { body = await req.clone().json(); } catch { return null; }
    const msg = body as { method?: unknown; params?: { name?: unknown } };
    if (msg?.method !== "tools/call" || typeof msg.params?.name !== "string") return null;
    const permission = (TOOL_PERMISSIONS as Record<string, Permission>)[msg.params.name];
    if (!permission || can(actor, permission)) return null;
    return SCOPE_FOR[permission] ?? null;
  }

  async #serve(req: Request, c: Context<AppEnv>): Promise<Response> {
    if (req.headers.has("origin")) return problemResponse(c, forbidden("browser requests are not accepted on the MCP surface"));

    const header = req.headers.get("authorization");
    const presented = header ? BEARER.exec(header)?.[1] : undefined;
    const actor = presented ? await this.#d.verifyToken(presented) : null;
    if (!actor) {
      return problemResponse(c, unauthorized(), { "www-authenticate": this.#challenge() });
    }
    const missing = await this.#stepUp(req, actor);
    if (missing) {
      return problemResponse(c, forbidden(`this connection was not granted the "${missing}" scope`), {
        "www-authenticate": this.#challenge().replace(/, scope="[^"]*"/, "") + `, error="insufficient_scope", scope="${missing === "deploy" ? "read deploy" : missing}"`,
      });
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
