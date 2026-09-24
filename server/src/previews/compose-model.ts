import { z } from "zod";
import { publicOriginFor, type PublicOrigin } from "@gangway/shared/url";
import { buildLabels, LABEL, labelsFromRoute, type LabelContext } from "../docker/labels.ts";
import { unprocessable } from "../errors.ts";
import { parseBytes } from "../util/bytes.ts";
import { parseDuration } from "../util/duration.ts";
import { obj, type Json } from "../util/json.ts";
import { literal } from "./compose-generate.ts";
import { arr, policyViolations } from "./compose-policy.ts";
import type { PlannedRoute } from "./planned-route.ts";

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

function parseExtension<T>(schema: z.ZodType<T>, raw: unknown, where: string): T {
  const r = schema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw unprocessable(
    `${where}: x-gangway${i?.path.length ? `.${i.path.join(".")}` : ""}: ${i?.message ?? "invalid"}`,
  );
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
  sharedNetwork?: string | null;
  limits?: PreviewLimits | undefined;
};

/** The operator's ceiling for every preview container; 0 leaves that limit off. */
export type PreviewLimits = { memoryBytes: number; cpus: number; pids: number };

export const NO_LIMITS: PreviewLimits = { memoryBytes: 0, cpus: 0, pids: 0 };

const positive = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

// The smallest of the operator's cap and whatever the file asked for, in either spelling; 0 is none.
const tightest = (...values: (number | null)[]) => {
  const set = values.filter((n): n is number => n !== null && n > 0);
  return set.length > 0 ? Math.min(...set) : 0;
};

const setOrDrop = (target: Json, key: string, value: unknown) => {
  if (value === 0 || value === null || value === undefined) delete target[key];
  else target[key] = value;
};

/**
 * One preview must not be able to take the host down with it (memory, a fork bomb), and gains
 * no privilege after it starts. Compose refuses two different values for one limit, so each
 * limit ends up in its top-level key alone.
 */
function confine(svc: Json, cap: PreviewLimits): void {
  const deploy = obj(svc["deploy"]);
  const resources = obj(deploy["resources"]);
  const limits = obj(resources["limits"]);
  const reservations = obj(resources["reservations"]);

  const memory = tightest(
    cap.memoryBytes || null,
    parseBytes(svc["mem_limit"]),
    parseBytes(limits["memory"]),
  );
  const cpus = tightest(cap.cpus || null, positive(svc["cpus"]), positive(limits["cpus"]));
  const pids = tightest(cap.pids || null, positive(svc["pids_limit"]), positive(limits["pids"]));
  for (const key of ["memory", "cpus", "pids"]) delete limits[key];

  setOrDrop(svc, "mem_limit", memory && String(memory));
  // Without this the container may swap as much again as its limit.
  setOrDrop(svc, "memswap_limit", memory && String(memory));
  if (memory > 0) {
    // Docker refuses a reservation above the limit.
    for (const [target, key] of [
      [svc, "mem_reservation"],
      [reservations, "memory"],
    ] as const) {
      const asked = parseBytes(target[key]);
      if (asked !== null && asked > memory) target[key] = String(memory);
    }
  }
  setOrDrop(svc, "cpus", cpus);
  setOrDrop(svc, "pids_limit", pids);

  if (Object.keys(limits).length > 0) resources["limits"] = limits;
  else delete resources["limits"];
  if (Object.keys(resources).length > 0) deploy["resources"] = resources;
  else delete deploy["resources"];
  if (Object.keys(deploy).length > 0) svc["deploy"] = deploy;
  else delete svc["deploy"];

  svc["security_opt"] = ["no-new-privileges:true"];
  // Raw sockets let one container spoof ARP and traffic on a network it shares with others.
  svc["cap_drop"] = [...new Set([...arr(svc["cap_drop"]).map(String), "NET_RAW"])];
}

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
    confine(svc, i.limits ?? NO_LIMITS);
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

  if (i.sharedNetwork)
    doc["networks"] = {
      ...obj(doc["networks"]),
      default: { name: i.sharedNetwork, external: true },
    };

  return `${JSON.stringify(doc, null, 2)}\n`;
}
