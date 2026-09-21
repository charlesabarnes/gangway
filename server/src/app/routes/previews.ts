/**
 * §10.1 previews. A THIN adapter (ADR-0003): parse, call the service layer, shape the
 * response. If logic appears in this file it is in the wrong file -- the webhook receiver
 * and the MCP tool will need it too, and they do not come through here.
 */
import type { Hono } from "hono";
import type { Preview } from "../../../../shared/src/domain.ts";
import { DeployRequestSchema, PreviewListQuerySchema, PreviewLogsQuerySchema, TARBALL_CONTENT_TYPES, TarballDeployQuerySchema } from "../../../../shared/src/api.ts";
import { badRequest, notFound } from "../../errors.ts";
import type { PreviewContext } from "../../previews/context.ts";
import { urlsFor, type DeployInput } from "../../previews/deploy.ts";
import type { IdempotentDeploys } from "../../previews/idempotent.ts";
import { destroy } from "../../previews/destroy.ts";
import { isUlid } from "../../util/ulid.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";
import { resumeCursor, sse, SSE_MAX_QUEUE, type SseOptions } from "../sse.ts";

export function previewRoutes(api: Hono<AppEnv>, ctx: PreviewContext, deploys: IdempotentDeploys, o: SseOptions = {}): void {
  const wire = (p: Preview) => ({ ...p, urls: urlsFor(ctx, p.id) });

  const find = (id: string): Preview => {
    // Checked before it goes anywhere: the id names a log file on disk.
    const p = isUlid(id) ? ctx.previews.get(id) : undefined;
    if (!p) throw notFound(`no such preview: ${id}`);
    return p;
  };

  api.post("/previews", requirePermission("previews.deploy"), async (c) => {
    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    let req: Omit<DeployInput, "actor">;
    if ((TARBALL_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      // The body is the archive, streamed straight into the extractor -- never buffered.
      const { ttl, ...q } = TarballDeployQuerySchema.parse(c.req.query());
      const archive = c.req.raw.body;
      if (!archive) throw badRequest("the request has no body; send the tar or tar.gz as the body");
      req = { ...q, ...(ttl === undefined ? {} : { ttl: ttl === "none" ? null : ttl }), source: { kind: "tarball", archive, port: q.port, digest: `len:${c.req.header("content-length") ?? "?"}` } };
    } else {
      const body = await c.req.json().catch(() => { throw badRequest("the request body is not JSON"); });
      req = DeployRequestSchema.parse(body);
    }
    // §10.1 "Idempotency-Key honored": a retried POST returns the preview the first one made.
    const res = await deploys.deploy({ ...req, actor: c.get("actor") }, c.req.header("idempotency-key"));
    if (res.replayed) c.header("idempotency-replayed", "true");

    // `?wait=true` holds the request until the pipeline settles -- what a script wants,
    // and what the MCP tool will want (§10.2: "blocks until the URL actually serves").
    if (c.req.query("wait") === "true") {
      const final = await res.done;
      return c.json({ preview: wire(final) }, final.state === "awake" ? 201 : 502);
    }
    c.header("location", `/v1/previews/${res.preview.id}`);
    return c.json({ preview: wire(res.preview) }, 202);
  });

  api.get("/previews", requirePermission("previews.read"), (c) => {
    const states = c.req.queries("state")?.flatMap((s) => s.split(",")).filter((s) => s !== "");
    const q = PreviewListQuerySchema.parse({ ...c.req.query(), state: states?.length ? states : undefined });
    // BEFORE the list: the UI follows /v1/events from `seq`, so a change landing between
    // the two reads is replayed onto a list that already has it, never missed.
    const seq = ctx.bus.latestSeq();
    const list = ctx.previews.list({
      ...(q.state ? { state: q.state } : {}), ...(q.hostId ? { hostId: q.hostId } : {}),
      ...(q.includeDestroyed === "true" ? { includeDestroyed: true } : {}),
    });
    return c.json({ seq, previews: list.map(wire) });
  });

  api.get("/previews/:id", requirePermission("previews.read"), (c) => c.json({ preview: wire(find(c.req.param("id"))) }));

  api.delete("/previews/:id", requirePermission("previews.destroy"), async (c) => {
    find(c.req.param("id"));
    return c.json({ preview: wire(await destroy(ctx, c.req.param("id"), c.get("actor"))) });
  });

  /** State changes, oldest first. Deleted with the preview row, like its log. */
  api.get("/previews/:id/events", requirePermission("events.read"), (c) => {
    const p = find(c.req.param("id"));
    return c.json({ events: ctx.bus.history(p.id).map((e) => ({ seq: e.seq, type: e.type, at: e.createdAt, ...e.payload })) });
  });

  /** One row per build attempt. The OUTPUT is in the log, on the `build` stream. */
  api.get("/previews/:id/builds", requirePermission("previews.read"), (c) => {
    const p = find(c.req.param("id"));
    return c.json({ builds: ctx.builds?.forPreview(p.id) ?? [] });
  });

  api.get("/previews/:id/logs", requirePermission("logs.read"), (c) => {
    const p = find(c.req.param("id"));
    const after = resumeCursor(c);
    const { tail } = PreviewLogsQuerySchema.parse(c.req.query());
    // Two short of the queue: one for the "earlier lines not shown" line, one spare.
    const maxReplay = (o.maxQueue ?? SSE_MAX_QUEUE) - 2;
    return sse(c, (push) =>
      ctx.logs.follow(p.id, after, (l) => push({
        id: String(l.n), event: "log", data: JSON.stringify({ at: new Date(l.ts).toISOString(), stream: l.stream, line: l.line }),
      }), { tail, maxReplay }), o);
  });
}
