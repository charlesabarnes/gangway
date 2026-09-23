import type { Host } from "@gangway/shared/domain";
import { buildLabel, fqdn } from "@gangway/shared/hostname";
import { unprocessable } from "../errors.ts";
import type { ComposeModel, ServiceModel } from "./compose-model.ts";
import type { PlannedRoute } from "./planned-route.ts";

export type ExposedService = {
  service: string;
  containerPort: number;
  subdomain: string | null;
  primary: boolean;
};

function chooseExposed(model: ComposeModel): ServiceModel[] {
  const chosen = model.services.filter((s) => s.x.expose === true);
  if (chosen.length > 0) return chosen;
  const publishing = model.services.filter(
    (s) => s.publishedTargets.length > 0 && s.x.expose !== false,
  );
  if (publishing.length !== 1) {
    throw unprocessable(
      publishing.length === 0
        ? "nothing to expose: no service publishes a port. Add `x-gangway: { expose: true, port: <n> }` to the service that should get a URL."
        : `ambiguous: ${publishing.map((s) => s.name).join(", ")} all publish ports. Mark the ones that should get a URL with \`x-gangway: { expose: true }\`.`,
    );
  }
  return publishing;
}

function exposedPort(s: ServiceModel): number {
  const candidates = [...new Set([...s.publishedTargets, ...s.exposed])];
  const containerPort = s.x.port ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (containerPort === undefined) {
    throw unprocessable(
      candidates.length === 0
        ? `service "${s.name}" is exposed but declares no port. Set \`x-gangway.port\`.`
        : `service "${s.name}" declares ports ${candidates.join(", ")}. Set \`x-gangway.port\` to the one that serves HTTP.`,
    );
  }
  return containerPort;
}

export function selectExposed(model: ComposeModel): ExposedService[] {
  const chosen = chooseExposed(model);
  const primaries = chosen.filter((s) => s.x.primary === true);
  if (primaries.length > 1)
    throw unprocessable(
      `only one service may be primary; found ${primaries.map((s) => s.name).join(", ")}`,
    );

  return chosen.map((s) => ({
    service: s.name,
    containerPort: exposedPort(s),
    subdomain: s.x.subdomain ?? null,
    primary: s.x.primary === true,
  }));
}

export type PlanInput = {
  previewId: string;
  slug: string;
  baseDomain: string;
  host: Pick<Host, "id" | "upstream" | "ports">;
  exposed: ExposedService[];
  allocate: (count: number) => number[];
};

export function planRoutes(i: PlanInput): PlannedRoute[] {
  const ports = i.allocate(i.exposed.length);
  const routes = i.exposed.map((e, idx): PlannedRoute => {
    const built = buildLabel(
      { kind: "slug", slug: i.slug },
      {
        service: e.subdomain ?? e.service,
        isPrimary: e.primary,
        isSingleService: i.exposed.length === 1,
      },
    );
    if (!built.ok)
      throw unprocessable(`cannot build a hostname for service "${e.service}": ${built.message}`, {
        reason: built.reason,
      });
    return {
      hostname: fqdn(built.label, i.baseDomain),
      previewId: i.previewId,
      service: e.service,
      containerPort: e.containerPort,
      upstream: { host: i.host.upstream.address, port: ports[idx]! },
      primary: e.primary || i.exposed.length === 1,
    };
  });
  const seen = new Set<string>();
  for (const r of routes) {
    if (seen.has(r.hostname))
      throw unprocessable(
        `two services resolve to the same hostname ${r.hostname}; give one a distinct \`x-gangway.subdomain\``,
      );
    seen.add(r.hostname);
  }
  return routes;
}
