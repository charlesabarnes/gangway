import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";
import { SCOPE_PERMISSIONS, type Permission, type Scope } from "@gangway/shared/permissions";
import type { Actor, TokenVerifier } from "../auth/actor.ts";
import { isOAuthActor } from "../oauth/server.ts";
import type { AppEnv } from "./env.ts";
import { errorHandler, problemResponse } from "./problem.ts";
import { forbidden, notFound, unauthorized } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { SurfaceHandler } from "../net/dispatch.ts";
import { ulid } from "../util/ulid.ts";
import type { Tools } from "../mcp/tools.ts";
import type { Uploads } from "../mcp/uploads.ts";

const BEARER = /^Bearer\s+(\S+)$/i;

export type McpSurfaceDeps = {
  tools: Tools;
  uploads?: Uploads | undefined;
  verifyToken: TokenVerifier;
  logger: Logger;
  oauth?:
    | {
        available: () => boolean;
        resource: () => string;
        resourceMetadata: () => Record<string, unknown>;
      }
    | undefined;
};

const SCOPE_FOR: Record<Permission, Scope | undefined> = Object.fromEntries(
  (["read", "deploy", "update"] as const)
    .flatMap((s) => SCOPE_PERMISSIONS[s].map((p) => [p, s] as const))
    .reverse(),
) as Record<Permission, Scope | undefined>;
const STEP_UP_SCOPES: Record<Scope, string> = {
  read: "read",
  deploy: "read deploy",
  update: "read deploy update",
  artifacts: "artifacts",
  admin: "admin",
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
      {
        responseMode: "sse",
        keepAliveMs: 15_000,
        onerror: (err) => d.logger.warn("mcp request rejected", { err: err.message }),
      },
    );

    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set("requestId", ulid());
      await next();
    });
    app.onError(errorHandler(d.logger));
    app.get("/.well-known/oauth-protected-resource", (c) => this.#prm(c));
    app.get("/.well-known/oauth-protected-resource/", (c) => this.#prm(c));
    app.on(
      ["GET", "DELETE"],
      "/",
      () => new Response("Method not allowed.", { status: 405, headers: { allow: "POST" } }),
    );
    app.post("/", (c) => this.#serve(c.req.raw, c));
    if (d.uploads) {
      const uploads = d.uploads;
      app.put("/uploads/:id", async (c) => {
        if (c.req.header("origin") !== undefined)
          return problemResponse(
            c,
            forbidden("browser requests are not accepted on the MCP surface"),
          );
        const declared = Number(c.req.header("content-length"));
        const got = await uploads.receive(
          c.req.param("id"),
          c.req.raw.body,
          Number.isFinite(declared) && declared > 0 ? declared : undefined,
        );
        return c.text(
          `received ${got.bytes} bytes, sha256 ${got.sha256}\nnow call deploy with upload: "${c.req.param("id")}"\n`,
          201,
        );
      });
    }
    app.all("*", (c) => problemResponse(c, notFound(`no such resource: ${c.req.path}`)));
    this.#app = app;
  }

  handler(): SurfaceHandler {
    return (req, ctx) => this.#app.fetch(req, { surface: "mcp", clientIp: ctx.clientIp });
  }

  get open(): number {
    return this.#live.size;
  }

  dropAll(): void {
    for (const l of this.#live) l.abort.abort();
    this.#live.clear();
  }

  #oauthOn(): boolean {
    return this.#d.oauth?.available() === true;
  }

  #prm(c: Context<AppEnv>): Response {
    if (!this.#oauthOn()) return problemResponse(c, notFound(`no such resource: ${c.req.path}`));
    return c.json(this.#d.oauth!.resourceMetadata(), 200, {
      "cache-control": "public, max-age=300",
    });
  }

  #challenge(extra = ""): string {
    if (!this.#oauthOn()) return 'Bearer realm="gangway"';
    return `Bearer resource_metadata="${this.#d.oauth!.resource()}/.well-known/oauth-protected-resource", scope="read deploy"${extra}`;
  }

  async #stepUp(req: Request, actor: Actor): Promise<Scope | null> {
    if (!isOAuthActor(actor)) return null;
    let body: unknown;
    try {
      body = await req.clone().json();
    } catch {
      return null;
    }
    const msg = body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    if (msg?.method !== "tools/call" || typeof msg.params?.name !== "string") return null;
    const permission = this.#d.tools.missingFor(actor, msg.params.name, msg.params.arguments);
    const scope = permission ? SCOPE_FOR[permission] : undefined;
    // Already granted means the role lacks it, and asking the user again would loop.
    if (!scope || actor.scopes.includes(scope)) return null;
    return scope;
  }

  async #serve(req: Request, c: Context<AppEnv>): Promise<Response> {
    if (req.headers.has("origin"))
      return problemResponse(c, forbidden("browser requests are not accepted on the MCP surface"));

    const header = req.headers.get("authorization");
    const presented = header ? BEARER.exec(header)?.[1] : undefined;
    const actor = presented ? await this.#d.verifyToken(presented) : null;
    if (!actor) {
      return problemResponse(c, unauthorized(), { "www-authenticate": this.#challenge() });
    }
    const missing = await this.#stepUp(req, actor);
    if (missing) {
      return problemResponse(
        c,
        forbidden(`this connection was not granted the "${missing}" scope`),
        {
          "www-authenticate":
            this.#challenge().replace(/, scope="[^"]*"/, "") +
            `, error="insufficient_scope", scope="${STEP_UP_SCOPES[missing]}"`,
        },
      );
    }

    const live: Live = { abort: new AbortController() };
    this.#live.add(live);
    let res: Response;
    try {
      res = await this.#mcp.fetch(req, {
        authInfo: {
          token: "[redacted]",
          clientId: "gangway",
          scopes: [],
          extra: { actor, signal: live.abort.signal },
        },
      });
    } catch (err) {
      this.#live.delete(live);
      throw err;
    }
    if (!res.body) {
      this.#live.delete(live);
      return res;
    }
    return new Response(this.#droppable(res.body, live), {
      status: res.status,
      headers: res.headers,
    });
  }

  #droppable(body: ReadableStream<Uint8Array>, live: Live): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    const done = () => {
      this.#live.delete(live);
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        live.abort.signal.addEventListener(
          "abort",
          () => {
            done();
            reader.cancel("the MCP surface was switched off").catch(() => {});
            try {
              controller.error(new Error("the MCP surface was switched off"));
            } catch {}
          },
          { once: true },
        );
      },
      pull: async (controller) => {
        try {
          const { done: end, value } = await reader.read();
          if (end) {
            done();
            controller.close();
          } else controller.enqueue(value);
        } catch (err) {
          done();
          try {
            controller.error(err);
          } catch {}
        }
      },
      cancel: (reason) => {
        done();
        return reader.cancel(reason);
      },
    });
  }
}
