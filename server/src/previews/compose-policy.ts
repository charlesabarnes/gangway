import { isAbsolute, resolve } from "node:path";
import { obj, type Json } from "../util/json.ts";
import { containedIn } from "./source/types.ts";

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type InSource = (p: string) => boolean;

function privilegeViolations(at: string, s: Json): string[] {
  const out: string[] = [];
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
  return out;
}

const nonEmpty = (v: unknown) =>
  v !== undefined && v !== null && (Array.isArray(v) ? v.length : Object.keys(obj(v)).length) > 0;

// The build reads this machine's disk: a context of / would ship gangway's own database into an image.
function buildViolations(at: string, s: Json, inSource: InSource): string[] {
  if (s["build"] === undefined || s["build"] === null) return [];
  const out: string[] = [];
  const b = typeof s["build"] === "string" ? { context: s["build"] } : obj(s["build"]);
  const context = typeof b["context"] === "string" ? b["context"] : "";
  if (!isAbsolute(context) || !inSource(resolve(context))) {
    out.push(
      `${at}: build.context must be a directory inside the uploaded source (remote and out-of-tree contexts are not allowed)`,
    );
  } else if (typeof b["dockerfile"] === "string" && !inSource(resolve(context, b["dockerfile"]))) {
    out.push(`${at}: build.dockerfile must be inside the uploaded source`);
  }
  for (const key of ["additional_contexts", "secrets", "ssh"] as const) {
    if (nonEmpty(b[key])) out.push(`${at}: build.${key} is not allowed`);
  }
  return out;
}

function mountViolations(at: string, s: Json): string[] {
  return arr(s["volumes"]).flatMap((v) => {
    const type = obj(v)["type"];
    return type === "volume" || type === "tmpfs"
      ? []
      : [
          `${at}: ${String(type)} mount of ${String(obj(v)["source"])} is not allowed (named volumes and tmpfs only)`,
        ];
  });
}

function serviceViolations(doc: Json, inSource: InSource): string[] {
  return Object.entries(obj(doc["services"])).flatMap(([name, raw]) => {
    const s = obj(raw);
    const at = `service "${name}"`;
    return [
      ...privilegeViolations(at, s),
      ...buildViolations(at, s, inSource),
      ...mountViolations(at, s),
    ];
  });
}

const readsServer = (r: Json) =>
  typeof r["content"] !== "string" ||
  r["file"] !== undefined ||
  r["environment"] !== undefined ||
  (r["external"] !== undefined && r["external"] !== false);

function inlineOnlyViolations(doc: Json): string[] {
  return (["secrets", "configs"] as const).flatMap((kind) =>
    Object.entries(obj(doc[kind]))
      .filter(([, raw]) => readsServer(obj(raw)))
      .map(
        ([key]) =>
          `${kind.slice(0, -1)} "${key}": only inline \`content:\` is allowed (file, environment and external sources read the server, not the upload)`,
      ),
  );
}

function resourceViolations(project: string, doc: Json): string[] {
  const out: string[] = [];
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

export function policyViolations(
  project: string,
  doc: Json,
  sourceDirs: readonly string[],
): string[] {
  const inSource = (p: string) => sourceDirs.some((d) => containedIn(d, p));
  return [
    ...serviceViolations(doc, inSource),
    ...inlineOnlyViolations(doc),
    ...resourceViolations(project, doc),
  ];
}
