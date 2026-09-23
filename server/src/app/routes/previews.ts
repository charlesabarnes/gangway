import type { Context, Hono } from "hono";
import type { Preview } from "@gangway/shared/domain";
import {
  DeployRequestSchema,
  PreviewPasswordChangeSchema,
  PreviewTitleChangeSchema,
  PREVIEW_PASSWORD_HEADER,
  PREVIEW_PASSWORD_MAX,
  PreviewListQuerySchema,
  PreviewLogsQuerySchema,
  SourceEditSchema,
  SourceReplaceQuerySchema,
  TARBALL_CONTENT_TYPES,
  TarballDeployQuerySchema,
} from "@gangway/shared/api";
import { badRequest, forbidden, notFound, unprocessable } from "../../errors.ts";
import { readJson } from "../problem.ts";
import type { PreviewContext } from "../../previews/context.ts";
import { urlsFor } from "../../previews/deploy-names.ts";
import type { DeployInput } from "../../previews/deploy-types.ts";
import type { IdempotentDeploys } from "../../previews/idempotent.ts";
import { destroy } from "../../previews/destroy.ts";
import type { RedeployInput } from "../../previews/redeploy-input.ts";
import { redeploy } from "../../previews/redeploy.ts";
import { previewAccess, setPreviewPassword } from "../../previews/password.ts";
import { mayRebuild } from "../../auth/actor.ts";
import { planFromDisk } from "../../previews/runtimes.ts";
import { isUlid } from "../../util/ulid.ts";
import type { AppEnv } from "../env.ts";
import { requirePermission } from "../middleware/auth.ts";
import { resumeCursor, sse, SSE_MAX_QUEUE, type SseOptions } from "../sse.ts";

const isTarball = (contentType: string) =>
  (TARBALL_CONTENT_TYPES as readonly string[]).includes(contentType);

type TarballQuery = ReturnType<typeof TarballDeployQuerySchema.parse>;

const contentTypeOf = (c: Context<AppEnv>) =>
  (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

function previewHelpers(ctx: PreviewContext) {
  return {
    ctx,
    wire: (p: Preview) => ({
      ...p,
      access: previewAccess(ctx.passwords, p),
      urls: urlsFor(ctx, p.id),
    }),
    find: (id: string): Preview => {
      // The id names a log file on disk.
      const p = isUlid(id) ? ctx.previews.get(id) : undefined;
      if (!p) throw notFound(`no such preview: ${id}`);
      return p;
    },
  };
}
type Previews = ReturnType<typeof previewHelpers>;

function chosenPassword(chosen: string | undefined, passwordMode: TarballQuery["password"]) {
  if (chosen !== undefined && passwordMode !== undefined)
    throw badRequest(`send either ?password= or the ${PREVIEW_PASSWORD_HEADER} header, not both`);
  if (chosen !== undefined && (chosen.length === 0 || chosen.length > PREVIEW_PASSWORD_MAX))
    throw unprocessable(`a password is 1 to ${PREVIEW_PASSWORD_MAX} characters`);
  if (chosen !== undefined) return { mode: "set" as const, value: chosen };
  return passwordMode ? { mode: passwordMode } : undefined;
}

function tarballRequest(c: Context<AppEnv>): Omit<DeployInput, "actor"> {
  const {
    ttl,
    project,
    runtime,
    port,
    addons,
    password: passwordMode,
    passwordLogin,
    ...q
  } = TarballDeployQuerySchema.parse(c.req.query());
  const archive = c.req.raw.body;
  if (!archive) throw badRequest("the request has no body; send the tar or tar.gz as the body");
  const password = chosenPassword(c.req.header(PREVIEW_PASSWORD_HEADER), passwordMode);
  return {
    ...q,
    ...(password ? { password } : {}),
    ...(passwordLogin ? { passwordLogin } : {}),
    ...(project ? { projectId: project } : {}),
    ...(ttl === undefined ? {} : { ttl: ttl === "none" ? null : ttl }),
    source: {
      kind: "tarball",
      archive,
      port,
      runtime,
      addons,
      digest: `len:${c.req.header("content-length") ?? "?"}`,
    },
  };
}

async function jsonRequest(c: Context<AppEnv>): Promise<Omit<DeployInput, "actor">> {
  const body = await readJson(c);
  const { project, ...parsed } = DeployRequestSchema.parse(body);
  return { ...parsed, ...(project ? { projectId: project } : {}) };
}

function deployRoutes(api: Hono<AppEnv>, { wire }: Previews, deploys: IdempotentDeploys): void {
  api.post("/previews", requirePermission("previews.deploy"), async (c) => {
    const req = isTarball(contentTypeOf(c)) ? tarballRequest(c) : await jsonRequest(c);
    const res = await deploys.deploy(
      { ...req, actor: c.get("actor") },
      c.req.header("idempotency-key"),
    );
    if (res.replayed) c.header("idempotency-replayed", "true");

    if (c.req.query("wait") === "true") {
      const final = await res.done;
      return c.json({ preview: wire(final) }, final.state === "awake" ? 201 : 502);
    }
    c.header("location", `/v1/previews/${res.preview.id}`);
    return c.json({ preview: wire(res.preview) }, 202);
  });
}

function readRoutes(api: Hono<AppEnv>, { ctx, wire, find }: Previews): void {
  api.get("/previews", requirePermission("previews.read"), (c) => {
    const states = c.req
      .queries("state")
      ?.flatMap((s) => s.split(","))
      .filter((s) => s !== "");
    const q = PreviewListQuerySchema.parse({
      ...c.req.query(),
      state: states?.length ? states : undefined,
    });
    // Read seq before the list so a change between the two reads is replayed, never missed.
    const seq = ctx.bus.latestSeq();
    const list = ctx.previews.list({
      ...(q.state ? { state: q.state } : {}),
      ...(q.hostId ? { hostId: q.hostId } : {}),
      ...(q.includeDestroyed === "true" ? { includeDestroyed: true } : {}),
    });
    return c.json({ seq, previews: list.map(wire) });
  });

  api.get("/previews/:id", requirePermission("previews.read"), (c) =>
    c.json({ preview: wire(find(c.req.param("id"))) }),
  );

  api.delete("/previews/:id", requirePermission("previews.destroy"), async (c) => {
    find(c.req.param("id"));
    return c.json({ preview: wire(await destroy(ctx, c.req.param("id"), c.get("actor"))) });
  });

  api.get("/previews/:id/events", requirePermission("events.read"), (c) => {
    const p = find(c.req.param("id"));
    return c.json({
      events: ctx.bus
        .history(p.id)
        .map((e) => ({ seq: e.seq, type: e.type, at: e.createdAt, ...e.payload })),
    });
  });

  api.get("/previews/:id/builds", requirePermission("previews.read"), (c) => {
    const p = find(c.req.param("id"));
    return c.json({ builds: ctx.builds.forPreview(p.id) ?? [] });
  });

  api.get("/previews/:id/source", requirePermission("previews.read"), async (c) => {
    const p = find(c.req.param("id"));
    if (!ctx.sources || p.source.kind !== "tarball" || !(await ctx.sources.has(p.id)))
      throw notFound("this preview keeps no source: only uploaded previews do");
    const listing = await ctx.sources.list(p.id);
    return c.json({ runtime: p.source.runtime ?? null, ...listing });
  });

  api.get("/previews/:id/plan", requirePermission("previews.read"), async (c) => {
    const p = find(c.req.param("id"));
    if (!ctx.sources || p.source.kind !== "tarball" || !(await ctx.sources.has(p.id)))
      throw notFound("this preview keeps no source: only uploaded previews do");
    return c.json(
      await planFromDisk(ctx.sources.dirFor(p.id), "auto", {
        previous: p.source.runtime ?? "own",
        previousAddons: p.source.addons,
      }),
    );
  });
}

function sourceRoutes(api: Hono<AppEnv>, { ctx, wire, find }: Previews): void {
  const rebuild = async (
    c: Context<AppEnv, "/previews/:id">,
    change: RedeployInput["change"],
    runtime: RedeployInput["runtime"],
    addons?: RedeployInput["addons"],
  ) => {
    const p = find(c.req.param("id"));
    const res = await redeploy(ctx, {
      actor: c.get("actor"),
      previewId: p.id,
      change,
      runtime,
      addons,
    });
    if (c.req.query("wait") === "true") {
      const o = await res.done;
      return c.json(
        {
          preview: wire(o.preview),
          buildId: o.buildId,
          outcome: o.outcome,
          ...(o.error ? { error: o.error } : {}),
        },
        o.outcome === "succeeded" ? 200 : 502,
      );
    }
    return c.json({ preview: wire(res.preview), buildId: res.buildId }, 202);
  };

  api.patch(
    "/previews/:id/source",
    requirePermission("previews.update_own", "previews.update"),
    async (c) => {
      const body = await readJson(c);
      const { files, runtime, addons } = SourceEditSchema.parse(body);
      return rebuild(c, { kind: "edit", files }, runtime, addons);
    },
  );

  api.put(
    "/previews/:id/source",
    requirePermission("previews.update_own", "previews.update"),
    async (c) => {
      const contentType = contentTypeOf(c);
      if (!isTarball(contentType))
        throw badRequest(
          `send the new source as a tar or tar.gz body (${TARBALL_CONTENT_TYPES.join(", ")})`,
        );
      const { runtime, addons } = SourceReplaceQuerySchema.parse(c.req.query());
      const archive = c.req.raw.body;
      if (!archive) throw badRequest("the request has no body; send the tar or tar.gz as the body");
      return rebuild(c, { kind: "replace", archive }, runtime, addons);
    },
  );
}

function changeable(ctx: PreviewContext, c: Context<AppEnv>, p: Preview, what: string): void {
  if (!mayRebuild(c.get("actor"), ctx.previews.ownerOf(p.id)))
    throw forbidden(
      `this preview was deployed by someone else: "previews.update_own" covers only your own, and changing any preview's ${what} needs "previews.update"`,
    );
}

function titleRoutes(api: Hono<AppEnv>, { ctx, wire, find }: Previews): void {
  api.put(
    "/previews/:id/title",
    requirePermission("previews.update_own", "previews.update"),
    async (c) => {
      const p = find(c.req.param("id"));
      changeable(ctx, c, p, "title");
      const { title } = PreviewTitleChangeSchema.parse(await readJson(c));
      ctx.previews.setTitle(p.id, title);
      ctx.audit.record(c.get("actor"), "preview.title", p.id, { old: p.title, new: title });
      return c.json({ preview: wire(ctx.previews.get(p.id)!) });
    },
  );
}

function passwordRoutes(api: Hono<AppEnv>, { ctx, wire, find }: Previews): void {
  api.put(
    "/previews/:id/password",
    requirePermission("previews.update_own", "previews.update"),
    async (c) => {
      const p = find(c.req.param("id"));
      const actor = c.get("actor");
      changeable(ctx, c, p, "password");
      const body = await readJson(c);
      const { password, login } = PreviewPasswordChangeSchema.parse(body);
      return c.json({
        preview: wire(
          await setPreviewPassword(ctx, { actor, previewId: p.id, choice: password, login }),
        ),
      });
    },
  );
}

function logRoutes(api: Hono<AppEnv>, { ctx, find }: Previews, o: SseOptions): void {
  api.get("/previews/:id/logs", requirePermission("logs.read"), (c) => {
    const p = find(c.req.param("id"));
    const after = resumeCursor(c);
    const { tail } = PreviewLogsQuerySchema.parse(c.req.query());
    const maxReplay = (o.maxQueue ?? SSE_MAX_QUEUE) - 2;
    return sse(
      c,
      (push) =>
        ctx.logs.follow(
          p.id,
          after,
          (l) =>
            push({
              id: String(l.n),
              event: "log",
              data: JSON.stringify({
                at: new Date(l.ts).toISOString(),
                stream: l.stream,
                line: l.line,
              }),
            }),
          { tail, maxReplay },
        ),
      o,
    );
  });
}

export function previewRoutes(
  api: Hono<AppEnv>,
  ctx: PreviewContext,
  deploys: IdempotentDeploys,
  o: SseOptions = {},
): void {
  const previews = previewHelpers(ctx);
  deployRoutes(api, previews, deploys);
  readRoutes(api, previews);
  sourceRoutes(api, previews);
  passwordRoutes(api, previews);
  titleRoutes(api, previews);
  logRoutes(api, previews, o);
}
