import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Host, Route } from "@gangway/shared/domain";
import { buildLabel, fqdn } from "@gangway/shared/hostname";
import { publicOriginFor, type PublicOrigin } from "@gangway/shared/url";
import { containedIn } from "./source/types.ts";
import type { RenderedAddons } from "./addons.ts";
import { buildLabels, LABEL, labelsFromRoute, type LabelContext } from "../docker/labels.ts";
import { unprocessable } from "../errors.ts";
import { parseDuration } from "../util/duration.ts";
import { obj, type Json } from "../util/json.ts";

const portNumber = z.number().int().min(1).max(65535);

const ServiceExtensionSchema = z.strictObject({
  expose: z.boolean().optional(),
  subdomain: z.string().min(1).max(40).optional(),
  primary: z.boolean().optional(),
  port: portNumber.optional(),
  health: z
    .string()
    .regex(/^\/[\x21-\x7e]*$/, "a path starting with /")
    .max(200)
    .optional(),
});
export type ServiceExtension = z.infer<typeof ServiceExtensionSchema>;

const StackExtensionSchema = z.strictObject({
  ttl: z
    .string()
    .refine((s) => parseDuration(s) !== null, "expected a duration like 12h or 7d")
    .optional(),
  seed: z
    .union([
      z.string().min(1),
      z.strictObject({ service: z.string().min(1), command: z.string().min(1) }),
    ])
    .optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  idle: z
    .string()
    .refine(
      (s) => s === "never" || parseDuration(s) !== null,
      "expected a duration like 30m, or never",
    )
    .optional(),
  release: z.string().min(1).max(8192).optional(),
});
export type StackExtension = z.infer<typeof StackExtensionSchema>;

export type ServiceModel = {
  name: string;
  image: string | null;
  hasBuild: boolean;
  publishedTargets: number[];
  exposed: number[];
  x: ServiceExtension;
};

export type ComposeModel = {
  services: ServiceModel[];
  networks: string[];
  volumes: string[];
  x: StackExtension;
  violations: string[];
};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseExtension<T>(schema: z.ZodType<T>, raw: unknown, where: string): T {
  const r = schema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw unprocessable(
    `${where}: x-gangway${i?.path.length ? `.${i.path.join(".")}` : ""}: ${i?.message ?? "invalid"}`,
  );
}

function policyViolations(project: string, doc: Json, sourceDirs: readonly string[]): string[] {
  const out: string[] = [];
  const inSource = (p: string) => sourceDirs.some((d) => containedIn(d, p));
  for (const [name, raw] of Object.entries(obj(doc["services"]))) {
    const s = obj(raw);
    const at = `service "${name}"`;
    if (s["privileged"] === true) out.push(`${at}: privileged is not allowed`);
    for (const key of ["network_mode", "pid", "ipc", "userns_mode", "cgroup"] as const) {
      if (s[key] === "host") out.push(`${at}: ${key}: host is not allowed`);
    }
    if (typeof s["network_mode"] === "string" && s["network_mode"].startsWith("container:")) {
      out.push(`${at}: network_mode: container:* is not allowed`);
    }
    // A fixed container_name escapes -p namespacing.
    if (s["container_name"] !== undefined)
      out.push(`${at}: container_name is not allowed (it defeats per-preview namespacing)`);
    if (arr(s["devices"]).length > 0) out.push(`${at}: devices are not allowed`);
    if (arr(s["cap_add"]).length > 0) out.push(`${at}: cap_add is not allowed`);
    if (arr(s["security_opt"]).length > 0) out.push(`${at}: security_opt is not allowed`);
    // The build reads this machine's disk: a context of / would ship gangway's own database into an image.
    if (s["build"] !== undefined && s["build"] !== null) {
      const b = typeof s["build"] === "string" ? { context: s["build"] } : obj(s["build"]);
      const context = typeof b["context"] === "string" ? b["context"] : "";
      if (!isAbsolute(context) || !inSource(resolve(context))) {
        out.push(
          `${at}: build.context must be a directory inside the uploaded source (remote and out-of-tree contexts are not allowed)`,
        );
      } else if (
        typeof b["dockerfile"] === "string" &&
        !inSource(resolve(context, b["dockerfile"]))
      ) {
        out.push(`${at}: build.dockerfile must be inside the uploaded source`);
      }
      for (const key of ["additional_contexts", "secrets", "ssh"] as const) {
        const v = b[key];
        if (
          v !== undefined &&
          v !== null &&
          (Array.isArray(v) ? v.length : Object.keys(obj(v)).length) > 0
        )
          out.push(`${at}: build.${key} is not allowed`);
      }
    }
    for (const v of arr(s["volumes"])) {
      const type = obj(v)["type"];
      if (type !== "volume" && type !== "tmpfs")
        out.push(
          `${at}: ${String(type)} mount of ${String(obj(v)["source"])} is not allowed (named volumes and tmpfs only)`,
        );
    }
  }
  for (const kind of ["secrets", "configs"] as const) {
    for (const [key, raw] of Object.entries(obj(doc[kind]))) {
      const r = obj(raw);
      if (
        typeof r["content"] !== "string" ||
        r["file"] !== undefined ||
        r["environment"] !== undefined ||
        (r["external"] !== undefined && r["external"] !== false)
      ) {
        out.push(
          `${kind.slice(0, -1)} "${key}": only inline \`content:\` is allowed (file, environment and external sources read the server, not the upload)`,
        );
      }
    }
  }
  for (const kind of ["networks", "volumes"] as const) {
    for (const [key, raw] of Object.entries(obj(doc[kind]))) {
      const r = obj(raw);
      const at = `${kind.slice(0, -1)} "${key}"`;
      if (r["external"] !== undefined && r["external"] !== false)
        out.push(`${at}: external is not allowed`);
      if (typeof r["name"] === "string" && r["name"] !== `${project}_${key}`)
        out.push(`${at}: a custom name is not allowed`);
      if (kind === "volumes" && Object.keys(obj(r["driver_opts"])).length > 0)
        out.push(`${at}: driver_opts are not allowed (a bind mount in disguise)`);
      if (kind === "networks" && r["driver"] !== undefined && r["driver"] !== "bridge")
        out.push(`${at}: only the bridge driver is allowed`);
    }
  }
  return out;
}

export function parseComposeModel(
  project: string,
  resolved: unknown,
  sourceDirs: readonly string[] = [],
): ComposeModel {
  const doc = obj(resolved);
  const rawServices = obj(doc["services"]);
  if (Object.keys(rawServices).length === 0)
    throw unprocessable("the compose file defines no services");

  const services = Object.entries(rawServices).map(([name, raw]): ServiceModel => {
    const s = obj(raw);
    return {
      name,
      image: typeof s["image"] === "string" ? s["image"] : null,
      hasBuild: s["build"] !== undefined && s["build"] !== null,
      publishedTargets: arr(s["ports"])
        .map(obj)
        .filter((p) => (p["protocol"] ?? "tcp") === "tcp" && typeof p["target"] === "number")
        .map((p) => p["target"] as number),
      exposed: arr(s["expose"])
        .map((e) => Number(String(e).split("/")[0]))
        .filter((n) => Number.isInteger(n) && n > 0),
      x: parseExtension(ServiceExtensionSchema, s["x-gangway"], `service "${name}"`),
    };
  });

  return {
    services,
    networks: Object.keys(obj(doc["networks"])),
    volumes: Object.keys(obj(doc["volumes"])),
    x: parseExtension(StackExtensionSchema, doc["x-gangway"], "stack"),
    violations: policyViolations(project, doc, sourceDirs),
  };
}

export type ExposedService = {
  service: string;
  containerPort: number;
  subdomain: string | null;
  primary: boolean;
};

export function selectExposed(model: ComposeModel): ExposedService[] {
  let chosen = model.services.filter((s) => s.x.expose === true);
  if (chosen.length === 0) {
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
    chosen = publishing;
  }

  const primaries = chosen.filter((s) => s.x.primary === true);
  if (primaries.length > 1)
    throw unprocessable(
      `only one service may be primary; found ${primaries.map((s) => s.name).join(", ")}`,
    );

  return chosen.map((s) => {
    const candidates = [...new Set([...s.publishedTargets, ...s.exposed])];
    const containerPort = s.x.port ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (containerPort === undefined) {
      throw unprocessable(
        candidates.length === 0
          ? `service "${s.name}" is exposed but declares no port. Set \`x-gangway.port\`.`
          : `service "${s.name}" declares ports ${candidates.join(", ")}. Set \`x-gangway.port\` to the one that serves HTTP.`,
      );
    }
    return {
      service: s.name,
      containerPort,
      subdomain: s.x.subdomain ?? null,
      primary: s.x.primary === true,
    };
  });
}

export type PlannedRoute = Omit<Route, "createdAt">;

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

export type StackInput = {
  resolved: unknown;
  planProject: string;
  model: ComposeModel;
  routes: PlannedRoute[];
  createdAt: Date;
  ctx: LabelContext;
  publishBind: string;
  origin: PublicOrigin;
  extraEnv?: Record<string, string>;
};

// Compose interpolates $ in every file it reads, so $$ is a literal.
const literal = (env: Record<string, string> = {}) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/\$/g, "$$$$")]));

const envKey = (service: string) =>
  `GANGWAY_URL_${service.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

function asMap(v: unknown): Record<string, unknown> {
  if (!Array.isArray(v)) return { ...obj(v) };
  return Object.fromEntries(
    v.map((e) => {
      const text = String(e);
      const i = text.indexOf("=");
      return i === -1 ? [text, null] : [text.slice(0, i), text.slice(i + 1)];
    }),
  );
}

export function buildStack(i: StackInput): string {
  const doc = structuredClone(obj(i.resolved));
  const previewId = i.routes[0]?.previewId ?? "";
  const ownership = {
    [LABEL.instance]: i.ctx.instance,
    [LABEL.env]: i.ctx.env,
    [LABEL.project]: i.ctx.project,
    [LABEL.previewId]: previewId,
  };
  const urls = Object.fromEntries(
    i.routes.map((r) => [envKey(r.service), publicOriginFor(r.hostname, i.origin)]),
  );
  const primary = i.routes.find((r) => r.primary) ?? i.routes[0];

  doc["name"] = i.ctx.project;

  const services = obj(doc["services"]);
  for (const [name, raw] of Object.entries(services)) {
    const svc = obj(raw);
    const route = i.routes.find((r) => r.service === name);
    const mine = route
      ? buildLabels(labelsFromRoute({ ...route, createdAt: i.createdAt }, i.ctx))
      : ownership;
    const theirs = Object.fromEntries(
      Object.entries(asMap(svc["labels"])).filter(([k]) => !k.startsWith("gangway.")),
    );
    svc["labels"] = { ...theirs, ...mine };

    if (route) {
      svc["ports"] = [
        {
          mode: "ingress",
          host_ip: i.publishBind,
          target: route.containerPort,
          published: String(route.upstream.port),
          protocol: "tcp",
        },
      ];
    } else {
      delete svc["ports"];
    }

    const self = route ?? primary;
    svc["environment"] = {
      ...asMap(svc["environment"]),
      ...literal(i.extraEnv),
      GANGWAY_PREVIEW_ID: previewId,
      ...urls,
      ...(self ? { PUBLIC_URL: publicOriginFor(self.hostname, i.origin) } : {}),
    };
    services[name] = svc;
  }

  for (const kind of ["networks", "volumes"] as const) {
    const section = obj(doc[kind]);
    for (const [key, raw] of Object.entries(section)) {
      const r = obj(raw);
      if (r["name"] === `${i.planProject}_${key}`) delete r["name"];
      r["labels"] = { ...asMap(r["labels"]), ...ownership };
      section[key] = r;
    }
    if (Object.keys(section).length > 0) doc[kind] = section;
  }

  return `${JSON.stringify(doc, null, 2)}\n`;
}

type Generated = {
  port: number;
  env?: Record<string, string> | undefined;
  stack?: Record<string, string> | undefined;
  health?: string | null | undefined;
  sidecars?: Pick<RenderedAddons, "services" | "volumes" | "dependsOn"> | undefined;
};

const generated = (o: Generated, web: Record<string, unknown>): string =>
  `${JSON.stringify(
    {
      ...(o.stack && Object.keys(o.stack).length ? { "x-gangway": o.stack } : {}),
      services: {
        web: {
          ...web,
          "x-gangway": { expose: true, port: o.port, ...(o.health ? { health: o.health } : {}) },
          ...(o.env && Object.keys(o.env).length ? { environment: literal(o.env) } : {}),
          ...(o.sidecars && Object.keys(o.sidecars.dependsOn).length
            ? { depends_on: o.sidecars.dependsOn }
            : {}),
          restart: "unless-stopped",
        },
        ...(o.sidecars?.services ?? {}),
      },
      ...(o.sidecars && Object.keys(o.sidecars.volumes).length
        ? { volumes: o.sidecars.volumes }
        : {}),
    },
    null,
    2,
  )}\n`;

export function composeForDockerfile(o: Generated): string {
  return generated(o, { build: { context: "." } });
}

export function composeForImage(o: {
  image: string;
  port: number;
  env?: Record<string, string> | undefined;
}): string {
  return generated(o, { image: o.image });
}

export function composeForRuntime(o: Generated & { context?: string }): string {
  return generated(o, {
    build: { context: o.context ?? ".", dockerfile: ".gangway/Dockerfile" },
    init: true,
  });
}
