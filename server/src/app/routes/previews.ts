/**
 * §10.1 previews. A THIN adapter (ADR-0003): parse, call the service layer, shape the
 * response. If logic appears in this file it is in the wrong file -- the webhook receiver
 * and the MCP tool will need it too, and they do not come through here.
 */
import type { Hono } from "hono";
import type { Preview } from "../../../../shared/src/domain.ts";
import { DeployRequestSchema, PreviewListQuerySchema } from "../../../../shared/src/api.ts";
import { badRequest, notFound } from "../../errors.ts";
import type { PreviewContext } from "../../previews/context.ts";
import { deploy, urlsFor } from "../../previews/deploy.ts";
import { destroy } from "../../previews/destroy.ts";
import { isUlid } from "../../util/ulid.ts";
import type { AppEnv } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { resumeCursor, sse, type SseOptions } from "../sse.ts";

export function previewRoutes(api: Hono<AppEnv>, ctx: PreviewContext, o: SseOptions = {}): void {
  const wire = (p: Preview) => ({ ...p, urls: urlsFor(ctx, p.id) });

  const find = (id: string): Preview => {
    // Checked before it goes anywhere: the id names a log file on disk.
    const p = isUlid(id) ? ctx.previews.get(id) : undefined;
    if (!p) throw notFound(`no such preview: ${id}`);
    return p;
  };

  api.post("/previews", requireScope("deploy"), async (c) => {
    const body = await c.req.json().catch(() => { throw badRequest("the request body is not JSON"); });
    const req = DeployRequestSchema.parse(body);
    const res = await deploy(ctx, { ...req, actor: c.get("actor") });

    // `?wait=true` holds the request until the pipeline settles -- what a script wants,
    // and what the MCP tool will want (§10.2: "blocks until the URL actually serves").
    if (c.req.query("wait") === "true") {
      const final = await res.done;
      return c.json({ preview: wire(final) }, final.state === "awake" ? 201 : 502);
    }
    c.header("location", `/v1/previews/${res.preview.id}`);
    return c.json({ preview: wire(res.preview) }, 202);
  });

  api.get("/previews", (c) => {
    const q = PreviewListQuerySchema.parse(c.req.query());
    const list = ctx.previews.list({ ...(q.state ? { state: q.state } : {}), ...(q.hostId ? { hostId: q.hostId } : {}) });
    return c.json({ previews: list.map(wire) });
  });

  api.get("/previews/:id", (c) => c.json({ preview: wire(find(c.req.param("id"))) }));

  api.delete("/previews/:id", requireScope("deploy"), async (c) => {
    find(c.req.param("id"));
    return c.json({ preview: wire(await destroy(ctx, c.req.param("id"), c.get("actor"))) });
  });

  api.get("/previews/:id/logs", (c) => {
    const p = find(c.req.param("id"));
    const after = resumeCursor(c);
    return sse(c, (push) =>
      ctx.logs.follow(p.id, after, (l) => push({
        id: String(l.n), event: "log", data: JSON.stringify({ at: new Date(l.ts).toISOString(), stream: l.stream, line: l.line }),
      })), o);
  });
}
