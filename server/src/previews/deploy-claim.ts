import {
  projectNameFor,
  type Clearance,
  type Host,
  type Preview,
  type PreviewSource,
  type Visibility,
} from "@gangway/shared/domain";
import { slugify } from "@gangway/shared/hostname";
import type { RuntimeId } from "@gangway/shared/runtimes";
import { principalOf } from "../auth/actor.ts";
import { conflict, unprocessable } from "../errors.ts";
import { allocatePorts } from "../routing/ports.ts";
import { idleMs } from "../util/duration.ts";
import type { ComposeModel } from "./compose-model.ts";
import { planRoutes, type ExposedService } from "./compose-routes.ts";
import type { PreviewContext } from "./context.ts";
import { defaultName, unguessable } from "./deploy-names.ts";
import type { DeployInput } from "./deploy-types.ts";
import { entryPassword, type ResolvedPassword } from "./password.ts";
import type { PlannedRoute } from "./planned-route.ts";
import type { ResolvedPolicy } from "./policy.ts";

export type Claim = {
  id: string;
  input: DeployInput;
  policy: ResolvedPolicy;
  host: Host;
  model: ComposeModel;
  exposed: ExposedService[];
  source: PreviewSource;
  runtime: RuntimeId | null;
  visibility: Visibility;
  ttlMs: number | null;
  secretLevel: Clearance;
  password: ResolvedPassword;
  /** Served by gangway from its files, not proxied to a container. */
  site?: boolean;
};

function slugFor(c: Claim): string {
  const stem = slugify(c.input.name ?? c.input.title ?? defaultName(c.input.source, c.runtime));
  if (stem === "") throw unprocessable("name has no usable characters");
  return c.visibility === "unlisted" ? `${stem}-${unguessable()}` : stem;
}

function createPreview(ctx: PreviewContext, c: Claim, project: string): Preview {
  const { template, project: owner } = c.policy;
  return ctx.previews.create({
    id: c.id,
    project,
    title: c.input.title ?? null,
    icon: c.input.icon ?? null,
    hostId: c.host.id,
    state: "building",
    source: c.source,
    visibility: c.visibility,
    ttlExpiresAt: c.ttlMs === null ? null : new Date(ctx.now() + c.ttlMs),
    idleAfterMs: idleMs(c.model.x.idle ?? template.idleAfter),
    secretLevel: c.secretLevel,
    templateId: template.id,
    projectId: owner?.id ?? null,
    owner: principalOf(c.input.actor),
    password: c.password.stored,
    passwordLogin: c.input.passwordLogin ?? "inherit",
  });
}

function claimRoutes(
  ctx: PreviewContext,
  c: Claim,
  preview: Preview,
  routes: PlannedRoute[],
): void {
  try {
    for (const route of routes) {
      ctx.table.apply({
        route: { ...route, createdAt: preview.createdAt },
        hostId: c.host.id,
        project: preview.project,
        visibility: c.visibility,
        password: entryPassword(c.password.stored),
        passwordLogin: c.input.passwordLogin ?? "inherit",
        state: "building",
        site: c.site ?? false,
      });
    }
  } catch (e) {
    ctx.table.removePreview(c.id);
    ctx.previews.delete(c.id);
    throw /UNIQUE|PRIMARY/i.test(String(e))
      ? conflict("that hostname is already taken by another preview")
      : e;
  }
}

// No await in here: until the route rows are claimed, concurrent deploys could take the same port.
export function claimPreview(
  ctx: PreviewContext,
  c: Claim,
): { preview: Preview; routes: PlannedRoute[] } {
  const slug = slugFor(c);
  const project = projectNameFor(ctx.instance, slug);
  const existing = ctx.previews.getByProject(project);
  if (existing && existing.state !== "destroyed") {
    throw conflict(`a preview named "${slug}" already exists`, {
      previewId: existing.id,
      state: existing.state,
    });
  }
  const routes = planRoutes({
    previewId: c.id,
    slug,
    baseDomain: ctx.baseDomain(),
    host: c.host,
    exposed: c.exposed,
    allocate: (n) =>
      allocatePorts(c.host.ports, ctx.table.usedPorts(c.host.upstream.address), n, c.host.id),
  });
  if (existing) {
    ctx.previews.delete(existing.id);
    ctx.logs.remove(existing.id);
  }
  const preview = createPreview(ctx, c, project);
  claimRoutes(ctx, c, preview, routes);
  return { preview, routes };
}
