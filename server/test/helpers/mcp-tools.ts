import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { tokenActor, type Actor } from "../../src/auth/actor.ts";
import { IdempotencyRepo, ProjectsRepo } from "../../src/db/repos/index.ts";
import type { CallScope } from "../../src/mcp/tool-deps.ts";
import { Tools } from "../../src/mcp/tools.ts";
import { SecretUploads } from "../../src/mcp/secret-uploads.ts";
import { Uploads } from "../../src/mcp/uploads.ts";
import { IdempotentDeploys } from "../../src/previews/idempotent.ts";
import { SourceStore } from "../../src/previews/source/store.ts";
import { SecretBox } from "../../src/secrets/box.ts";
import { Secrets } from "../../src/secrets/secrets.ts";
import { MemorySettingsStore } from "../../src/settings.ts";
import { tempDir } from "./db.ts";
import { silentLogger } from "./logger.ts";
import { ACTOR, setupPreviewContext } from "./preview-context.ts";

export const READ_ONLY = tokenActor("t-read", ["read"]);

/**
 * The MCP tools over a real PreviewContext with only compose faked, and a kept-source store.
 * `uploads` adds an upload store in its own directory.
 */
export function setupTools(o: { uploads?: { maxBytes?: number } } = {}) {
  const s = setupPreviewContext();
  s.ctx.sources = new SourceStore(dirname(s.ctx.workdirs.root));
  const uploadDir = tempDir();
  const uploads = o.uploads
    ? new Uploads({
        dir: uploadDir,
        url: (id) => `https://mcp.preview.localhost:8443/uploads/${id}`,
        now: s.ctx.now,
        ...o.uploads,
      })
    : undefined;
  const deploys = new IdempotentDeploys(s.ctx, new IdempotencyRepo(s.db, s.ctx.now));
  const projects = new ProjectsRepo(s.db, s.ctx.now);
  const secrets = new Secrets(
    projects,
    new MemorySettingsStore(),
    new SecretBox(randomBytes(32)),
    s.ctx.audit,
    s.ctx.previews,
  );
  s.ctx.secrets = secrets;
  s.ctx.secretsFor = (id, clearance) => secrets.valuesFor(id, clearance);
  const secretUploads = new SecretUploads({
    url: (id) => `https://mcp.preview.localhost:8443/secret-uploads/${id}`,
    now: s.ctx.now,
  });
  const tools = new Tools({
    ctx: s.ctx,
    deploys,
    logger: silentLogger(),
    ...(uploads ? { uploads } : {}),
    projects: { repo: projects, apiOrigin: () => "https://api.preview.localhost:8443" },
    secretUploads,
    findProject: (ref) => projects.find(ref),
  });
  const scope = (actor: Actor = ACTOR, signal = new AbortController().signal): CallScope => ({
    actor,
    signal,
  });
  return { ...s, deploys, tools, scope, uploads, uploadDir, projects, secrets, secretUploads };
}
