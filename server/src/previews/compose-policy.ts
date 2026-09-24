import { isAbsolute, resolve } from "node:path";
import { obj, type Json } from "../util/json.ts";
import { containedIn } from "./source/types.ts";

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type InSource = (p: string) => boolean;

const nonEmpty = (v: unknown) =>
  v !== undefined && v !== null && (Array.isArray(v) ? v.length : Object.keys(obj(v)).length) > 0;

const unset = (v: unknown) => v === undefined || v === null || v === "" || v === "default";

// `host` shares the machine's namespace and `container:x` shares any container's, the operator's too.
const sharesNamespace = (v: unknown) =>
  typeof v === "string" && (v === "host" || v.startsWith("container:"));

function privilegeViolations(at: string, s: Json): string[] {
  const out: string[] = [];
  if (s["privileged"] === true) out.push(`${at}: privileged is not allowed`);
  for (const key of ["pid", "ipc", "uts", "userns_mode", "cgroup"] as const) {
    if (sharesNamespace(s[key])) out.push(`${at}: ${key}: ${String(s[key])} is not allowed`);
  }
  out.push(...networkModeViolations(at, s["network_mode"]));
  // A fixed container_name escapes -p namespacing.
  if (s["container_name"] !== undefined)
    out.push(`${at}: container_name is not allowed (it defeats per-preview namespacing)`);
  if (arr(s["cap_add"]).length > 0) out.push(`${at}: cap_add is not allowed`);
  if (arr(s["security_opt"]).length > 0) out.push(`${at}: security_opt is not allowed`);
  // The daemon's API in the container, and a plugin binary run on this machine.
  if (s["use_api_socket"] === true) out.push(`${at}: use_api_socket is not allowed`);
  if (s["provider"] !== undefined) out.push(`${at}: provider services are not allowed`);
  for (const hook of ["post_start", "pre_stop"] as const) {
    if (arr(s[hook]).some((h) => obj(h)["privileged"] === true))
      out.push(`${at}: a privileged ${hook} hook is not allowed`);
  }
  if (arr(s["volumes_from"]).some((v) => String(v).startsWith("container:")))
    out.push(`${at}: volumes_from a container outside the preview is not allowed`);
  if (arr(s["external_links"]).length > 0) out.push(`${at}: external_links are not allowed`);
  return out;
}

function kernelViolations(at: string, s: Json): string[] {
  const out: string[] = [];
  for (const key of ["runtime", "isolation"] as const)
    if (!unset(s[key])) out.push(`${at}: ${key} is not allowed`);
  for (const key of ["sysctls", "extra_hosts", "dns", "dns_search", "dns_opt", "storage_opt"])
    if (nonEmpty(s[key]) || (typeof s[key] === "string" && s[key] !== ""))
      out.push(`${at}: ${key} is not allowed`);
  return out;
}

const bareName = (image: string) =>
  image
    .replace(/@.*$/, "")
    .replace(/:[^/]*$/, "")
    .replace(/^(docker\.io\/)?(library\/)?/, "");

/** gangway names what it builds `gw-<instance>-<slug>-<service>`: another preview's image, perhaps with its secrets in a layer. */
export const gangwayImage = (image: unknown) =>
  typeof image === "string" && bareName(image).startsWith("gw-");

function imageViolations(at: string, s: Json): string[] {
  const out: string[] = [];
  if (gangwayImage(s["image"]))
    out.push(`${at}: image ${String(s["image"])} is not allowed (gw-* images are gangway's own)`);
  const tags = arr(obj(s["build"])["tags"]).filter(gangwayImage);
  if (tags.length > 0) out.push(`${at}: build.tags ${tags.join(", ")} are not allowed`);
  return out;
}

function linkViolations(at: string, s: Json, services: ReadonlySet<string>): string[] {
  return arr(s["links"])
    .map((l) => String(l).split(":")[0]!)
    .filter((name) => !services.has(name))
    .map((name) => `${at}: links to ${name}, which is not a service of this preview`);
}

// Hardware, and the cgroup and OOM settings that would let one preview starve the host's other work.
function hostResourceViolations(at: string, s: Json): string[] {
  const out: string[] = [];
  if (arr(s["devices"]).length > 0) out.push(`${at}: devices are not allowed`);
  if (arr(s["device_cgroup_rules"]).length > 0)
    out.push(`${at}: device_cgroup_rules are not allowed`);
  if (s["gpus"] !== undefined && s["gpus"] !== null) out.push(`${at}: gpus are not allowed`);
  if (arr(obj(obj(obj(s["deploy"])["resources"])["reservations"])["devices"]).length > 0)
    out.push(`${at}: deploy.resources.reservations.devices are not allowed`);
  if (s["cgroup_parent"] !== undefined) out.push(`${at}: cgroup_parent is not allowed`);
  if (s["oom_kill_disable"] === true) out.push(`${at}: oom_kill_disable is not allowed`);
  if (typeof s["oom_score_adj"] === "number" && s["oom_score_adj"] < 0)
    out.push(`${at}: a negative oom_score_adj is not allowed`);
  return out;
}

// Only the preview's own networks: `bridge` is the default bridge the operator's containers share, and any other name is someone else's network.
function networkModeViolations(at: string, mode: unknown): string[] {
  if (mode === undefined || mode === null || mode === "none") return [];
  if (typeof mode !== "string") return [`${at}: network_mode must be a string`];
  if (mode.startsWith("service:")) return [];
  if (mode.startsWith("container:")) return [`${at}: network_mode: container:* is not allowed`];
  return [`${at}: network_mode: ${mode} is not allowed`];
}

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
  for (const key of [
    "additional_contexts",
    "secrets",
    "ssh",
    "entitlements",
    "extra_hosts",
    // `type=local` reads and writes a directory on this machine; a registry cache mixes previews' layers.
    "cache_from",
    "cache_to",
  ] as const) {
    if (nonEmpty(b[key])) out.push(`${at}: build.${key} is not allowed`);
  }
  if (b["privileged"] === true) out.push(`${at}: build.privileged is not allowed`);
  if (!unset(b["isolation"])) out.push(`${at}: build.isolation is not allowed`);
  // `host` runs build steps in the machine's network: every port bound to its loopback.
  const net = b["network"];
  if (net !== undefined && net !== null && net !== "default" && net !== "none")
    out.push(
      `${at}: build.network: ${typeof net === "string" ? net : JSON.stringify(net)} is not allowed`,
    );
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
  const names = new Set(Object.keys(obj(doc["services"])));
  return Object.entries(obj(doc["services"])).flatMap(([name, raw]) => {
    const s = obj(raw);
    const at = `service "${name}"`;
    return [
      ...privilegeViolations(at, s),
      ...kernelViolations(at, s),
      ...imageViolations(at, s),
      ...linkViolations(at, s, names),
      ...hostResourceViolations(at, s),
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
