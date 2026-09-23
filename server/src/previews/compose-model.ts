/**
 * The compose model: what we need to KNOW about a stack, and the stack file we actually
 * run, which carries everything we need to CHANGE about it.
 *
 * §7.1 says do not reimplement the Compose spec, so we never interpret compose.yaml. We
 * read the output of `docker compose config` -- compose's own canonical view, after
 * `extends`, profiles, includes and interpolation -- and this module is pure functions
 * over that document. No process, no daemon: all unit-testable.
 *
 * §7.2 says never edit the user's compose.yaml, and we do not. What we `up` is compose's
 * canonical output with our changes applied: labels (§4.1), the self-allocated published
 * port (ADR-0004) and the public URL env (§6.4). Verified on Compose v2.22 and v2.29:
 * `config` output is a FIXPOINT -- feeding it back yields the identical document, with
 * `$` still escaped as `$$` -- so running it is running what the user wrote.
 *
 * Two things this design deliberately AVOIDS, both learned the hard way:
 *
 *  - `config --format json`. It silently DROPS service-level `x-*` keys (v2.22: always;
 *    v2.29: unless --no-interpolate). The YAML output keeps them on every version.
 *  - A second `-f` override file. Compose merges `ports` by APPENDING, so replacing a
 *    port needs the `!override` tag, which needs Compose >= 2.24 -- and Docker Desktop
 *    still ships 2.22. Owning the final document needs no merge semantics at all.
 */
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Host, Route } from "@gangway/shared/domain";
import { buildLabel, fqdn } from "@gangway/shared/hostname";
import { publicOriginFor, type PublicOrigin } from "@gangway/shared/url";
import { containedIn } from "./source/types.ts";
import type { RenderedAddons } from "./addons.ts";
import { buildLabels, LABEL, labelsFromRoute, type LabelContext } from "../docker/labels.ts";
import { AppError } from "../errors.ts";
import { parseDuration } from "../util/duration.ts";

const unprocessable = (m: string, d?: Record<string, unknown>) =>
  new AppError("unprocessable", m, d);

/* ------------------------------------------------------------------ x-gangway */

const portNumber = z.number().int().min(1).max(65535);

export const ServiceExtensionSchema = z.strictObject({
  expose: z.boolean().optional(),
  subdomain: z.string().min(1).max(40).optional(),
  primary: z.boolean().optional(),
  /** Which container port to route to, when the service publishes several (or none). */
  port: portNumber.optional(),
  /**
   * A path that must answer 2xx/3xx before the service counts as up (ADR-0016). Omitted:
   * any HTTP answer on `/`. Checked on deploy and rebuild; a wake uses the plain probe.
   */
  health: z
    .string()
    .regex(/^\/[\x21-\x7e]*$/, "a path starting with /")
    .max(200)
    .optional(),
});
export type ServiceExtension = z.infer<typeof ServiceExtensionSchema>;

export const StackExtensionSchema = z.strictObject({
  ttl: z
    .string()
    .refine((s) => parseDuration(s) !== null, "expected a duration like 12h or 7d")
    .optional(),
  /**
   * §7.3: run once after the stack is healthy, before routes go live (ADR-0012). A string
   * runs in the PRIMARY service; `{ service, command }` picks another. `sh -c`, so a
   * script path or a one-liner both work.
   */
  seed: z
    .union([
      z.string().min(1),
      z.strictObject({ service: z.string().min(1), command: z.string().min(1) }),
    ])
    .optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  /** Idle-sleep after this long without a request; `never` opts the stack out (ADR-0012). */
  idle: z
    .string()
    .refine(
      (s) => s === "never" || parseDuration(s) !== null,
      "expected a duration like 30m, or never",
    )
    .optional(),
  /**
   * ADR-0016: runs before EVERY version goes live (migrations), in a one-off container of
   * the primary service, `sh -c`. On a rebuild, before the swap: failing it keeps the old
   * version serving. On a first deploy, once the stack is healthy and before the seed.
   */
  release: z.string().min(1).max(8192).optional(),
});
export type StackExtension = z.infer<typeof StackExtensionSchema>;

/* ------------------------------------------------------------------ the model */

export type ServiceModel = {
  name: string;
  image: string | null;
  hasBuild: boolean;
  /** Container-side TCP ports from `ports:`, in file order. */
  publishedTargets: number[];
  /** Container-side ports from `expose:`. */
  exposed: number[];
  x: ServiceExtension;
};

export type ComposeModel = {
  services: ServiceModel[];
  /** KEYS as written in the file, which is what an override file addresses. */
  networks: string[];
  volumes: string[];
  x: StackExtension;
  /** Policy violations. Non-empty means we refuse to run this stack. */
  violations: string[];
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseExtension<T>(schema: z.ZodType<T>, raw: unknown, where: string): T {
  const r = schema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw unprocessable(
    `${where}: x-gangway${i?.path.length ? `.${i.path.join(".")}` : ""}: ${i?.message ?? "invalid"}`,
  );
}

/**
 * What a preview may not ask of the host. Previews are throwaway code -- in Phase 3,
 * a stranger's pull request -- on a daemon that also runs the operator's real workloads.
 * Each rule is a way out of the project's namespace or onto the host itself.
 */
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
    // A fixed name escapes `-p` namespacing: the second preview of the same repo collides.
    if (s["container_name"] !== undefined)
      out.push(`${at}: container_name is not allowed (it defeats per-preview namespacing)`);
    if (arr(s["devices"]).length > 0) out.push(`${at}: devices are not allowed`);
    if (arr(s["cap_add"]).length > 0) out.push(`${at}: cap_add is not allowed`);
    if (arr(s["security_opt"]).length > 0) out.push(`${at}: security_opt is not allowed`);
    // The build runs on THIS machine's filesystem before anything reaches the daemon: a
    // context of `/` or `../../state` would ship gangway's own database into an image the
    // submitter then runs. `config` has already made these paths absolute.
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
      // The daemon is remote: a bind path names a directory on the HOST, not in the
      // upload. `/var/run/docker.sock` is the famous one; none of them are safe.
      if (type !== "volume" && type !== "tmpfs")
        out.push(
          `${at}: ${String(type)} mount of ${String(obj(v)["source"])} is not allowed (named volumes and tmpfs only)`,
        );
    }
  }
  // `file:` reads this machine's disk and `environment:` reads gangway's own environment;
  // `external` reaches for something the operator owns. Inline `content:` is the safe one.
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
      // `external` attaches to something the operator owns; a custom `name` does the
      // same thing by a different door. Either survives `down -v` and outlives us.
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

/**
 * @param resolved    the parsed YAML output of `docker compose config`
 * @param sourceDirs  where the source was unpacked (as given, and realpath'd): anything a
 *                    build reads must be inside one of them. None given, no build may run.
 */
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

/* ------------------------------------------------------------------ what is exposed */

export type ExposedService = {
  service: string;
  containerPort: number;
  subdomain: string | null;
  primary: boolean;
};

/**
 * §7.2: "Default with no extension: the single service with a published port is exposed."
 * Anything more ambiguous than that is an error naming the fix, never a guess -- a guess
 * here is a public URL pointing at somebody's database.
 */
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

/* ------------------------------------------------------------------ the route plan */

export type PlannedRoute = Omit<Route, "createdAt">;

export type PlanInput = {
  previewId: string;
  /** The hostname stem, already carrying the unlisted suffix if there is one. */
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

/* ------------------------------------------------------------------ the stack we run */

export type StackInput = {
  /** The same parsed `config` document the model was read from. Not mutated. */
  resolved: unknown;
  /** The placeholder `-p` that `config` ran under; its derived names are stripped. */
  planProject: string;
  model: ComposeModel;
  routes: PlannedRoute[];
  createdAt: Date;
  ctx: LabelContext;
  publishBind: string;
  origin: PublicOrigin;
  extraEnv?: Record<string, string>;
};

/** Compose interpolates `$` in every file it reads, this one included. `$$` is a literal. */
const literal = (env: Record<string, string> = {}) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/\$/g, "$$$$")]));

const envKey = (service: string) =>
  `GANGWAY_URL_${service.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

/** `environment` and `labels` are maps in canonical output, but lists are legal input. */
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
  // Ownership without `gangway.managed`: enough to find and remove everything a preview
  // created, deliberately NOT enough to look like a route. `managed=true` promises the
  // reconciler a complete route record (§4.1); a database sidecar has none, and would be
  // stopped as a malformed orphan.
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
    // Ours LAST: a compose file may set any label it likes, including `gangway.*` ones
    // that claim to be someone else's preview. It does not get to keep them.
    const theirs = Object.fromEntries(
      Object.entries(asMap(svc["labels"])).filter(([k]) => !k.startsWith("gangway.")),
    );
    svc["labels"] = { ...theirs, ...mine };

    // EVERY service's ports are replaced, not just the routed one's. A sidecar's
    // `5432:5432` would otherwise bind the operator's host -- outside our pool, and on
    // top of their real Postgres.
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
      // §6.4: Vite and Next need their own external hostname to build absolute URLs.
      ...(self ? { PUBLIC_URL: publicOriginFor(self.hostname, i.origin) } : {}),
    };
    services[name] = svc;
  }

  for (const kind of ["networks", "volumes"] as const) {
    const section = obj(doc[kind]);
    for (const [key, raw] of Object.entries(section)) {
      const r = obj(raw);
      // `config` bakes in names derived from the PLACEHOLDER project. Left in place,
      // every preview would share one `gw-plan_default` network. Dropped, compose
      // derives them again from the real `-p`. (Policy has already refused any name
      // that was not derived, so there is nothing legitimate to lose.)
      if (r["name"] === `${i.planProject}_${key}`) delete r["name"];
      r["labels"] = { ...asMap(r["labels"]), ...ownership };
      section[key] = r;
    }
    if (Object.keys(section).length > 0) doc[kind] = section;
  }

  // JSON is YAML. Compose reads it; nothing can be re-typed by a YAML emitter's quoting.
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/* ------------------------------------------------------------------ generated stacks */

type Generated = {
  port: number;
  env?: Record<string, string> | undefined;
  /** Stack-level `x-gangway` (ttl, visibility, idle, seed, release) from gangway.yml. */
  stack?: Record<string, string> | undefined;
  health?: string | null | undefined;
  /** Add-on services (ADR-0017), from `renderAddons`. The app waits for them to be healthy. */
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

/** A source with a Dockerfile and nothing else: build it, expose it. */
export function composeForDockerfile(o: Generated): string {
  return generated(o, { build: { context: "." } });
}

/** An image deploy is a one-service stack (§7): same pipeline, no special case downstream. */
export function composeForImage(o: {
  image: string;
  port: number;
  env?: Record<string, string> | undefined;
}): string {
  return generated(o, { image: o.image });
}

/**
 * A runtime's stack (ADR-0015): built from the generated `.gangway/Dockerfile` in the app's
 * root, secrets as the container's environment (never a `.env` in the build context), and
 * an init process, because `npm start` and friends make poor PID 1s.
 */
export function composeForRuntime(o: Generated & { context?: string }): string {
  return generated(o, {
    build: { context: o.context ?? ".", dockerfile: ".gangway/Dockerfile" },
    init: true,
  });
}
