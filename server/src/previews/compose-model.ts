import { z } from "zod";
import { publicOriginFor, type PublicOrigin } from "@gangway/shared/url";
import { buildLabels, LABEL, labelsFromRoute, type LabelContext } from "../docker/labels.ts";
import { unprocessable } from "../errors.ts";
import { parseDuration } from "../util/duration.ts";
import { obj } from "../util/json.ts";
import { literal } from "./compose-generate.ts";
import { arr, policyViolations } from "./compose-policy.ts";
import type { PlannedRoute } from "./compose-routes.ts";

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
};

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
