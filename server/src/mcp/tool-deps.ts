import type { Actor } from "../auth/actor.ts";
import type { Logger } from "../logger.ts";
import type { PreviewContext } from "../previews/context.ts";
import type { IdempotentDeploys } from "../previews/idempotent.ts";
import type { Uploads } from "./uploads.ts";

export type ToolDeps = {
  ctx: PreviewContext;
  deploys: IdempotentDeploys;
  logger: Logger;
  uploads?: Uploads | undefined;
};

export type CallScope = { actor: Actor; signal: AbortSignal };
