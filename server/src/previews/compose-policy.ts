import { must } from "@gangway/shared/must";
import { isAbsolute, resolve } from "node:path";
import { obj, type Json } from "../util/json.ts";
import { unknownFields } from "./compose-allowlist.ts";
import { containedIn } from "./source/types.ts";

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type InSource = (p: string) => boolean;

const unset = (v: unknown) => v === undefined || v === null || v === "" || v === "default";

// The fields allowed whose values can still reach past the preview.
function valueViolations(at: string, s: Json): string[] {
  const out: string[] = [];
  out.push(...networkModeViolations(at, s["network_mode"]));
  for (const hook of ["post_start", "pre_stop"] as const) {
    if (arr(s[hook]).some((h) => obj(h)["privileged"] === true)) {
      out.push(`${at}: a privileged ${hook} hook is not allowed`);
    }
  }
  if (arr(s["volumes_from"]).some((v) => String(v).startsWith("container:"))) {
    out.push(`${at}: volumes_from a container outside the preview is not allowed`);
  }
  // A negative score makes the kernel kill the host's other work first.
  if (typeof s["oom_score_adj"] === "number" && s["oom_score_adj"] < 0) {
    out.push(`${at}: a negative oom_score_adj is not allowed`);
  }
  for (const key of ["runtime", "isolation"] as const) {
    if (!unset(s[key])) {
      out.push(`${at}: ${key} is not allowed`);
    }
  }
  return out;
}

/** `image` without its `@digest` and its `:tag` (a colon after the last slash). */
const untagged = (image: string) => {
  const at = image.indexOf("@");
  const name = at === -1 ? image : image.slice(0, at);
  const colon = name.indexOf(":", name.lastIndexOf("/") + 1);
  return colon === -1 ? name : name.slice(0, colon);
};

const bareName = (image: string) => untagged(image).replace(/^(docker\.io\/)?(library\/)?/, "");

/** gangway names what it builds `gw-<instance>-<slug>-<service>`: another preview's image, perhaps with its secrets in a layer. */
export const gangwayImage = (image: unknown) =>
  typeof image === "string" && bareName(image).startsWith("gw-");

function imageViolations(at: string, s: Json): string[] {
  const out: string[] = [];
  if (gangwayImage(s["image"])) {
    out.push(`${at}: image ${String(s["image"])} is not allowed (gw-* images are gangway's own)`);
  }
  const tags = arr(obj(s["build"])["tags"]).filter(gangwayImage);
  if (tags.length > 0) {
    out.push(`${at}: build.tags ${tags.join(", ")} are not allowed`);
  }
  return out;
}

function linkViolations(at: string, s: Json, services: ReadonlySet<string>): string[] {
  return arr(s["links"])
    .map((l) => must(String(l).split(":")[0], "a link's service name"))
    .filter((name) => !services.has(name))
    .map((name) => `${at}: links to ${name}, which is not a service of this preview`);
}

// Only the preview's own networks: `bridge` is the default bridge the operator's containers share, and any other name is someone else's network.
function networkModeViolations(at: string, mode: unknown): string[] {
  if (mode === undefined || mode === null || mode === "none") {
    return [];
  }
  if (typeof mode !== "string") {
    return [`${at}: network_mode must be a string`];
  }
  if (mode.startsWith("service:")) {
    return [];
  }
  if (mode.startsWith("container:")) {
    return [`${at}: network_mode: container:* is not allowed`];
  }
  return [`${at}: network_mode: ${mode} is not allowed`];
}

// The build reads this machine's disk: a context of / would ship gangway's own database into an image.
function buildViolations(at: string, s: Json, inSource: InSource): string[] {
  if (s["build"] === undefined || s["build"] === null) {
    return [];
  }
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
  if (!unset(b["isolation"])) {
    out.push(`${at}: build.isolation is not allowed`);
  }
  // `host` runs build steps in the machine's network: every port bound to its loopback.
  const net = b["network"];
  if (net !== undefined && net !== null && net !== "default" && net !== "none") {
    out.push(
      `${at}: build.network: ${typeof net === "string" ? net : JSON.stringify(net)} is not allowed`,
    );
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
  const names = new Set(Object.keys(obj(doc["services"])));
  return Object.entries(obj(doc["services"])).flatMap(([name, raw]) => {
    const s = obj(raw);
    const at = `service "${name}"`;
    return [
      ...valueViolations(at, s),
      ...imageViolations(at, s),
      ...linkViolations(at, s, names),
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
  return (["networks", "volumes"] as const).flatMap((kind) =>
    Object.entries(obj(doc[kind])).flatMap(([key, raw]) =>
      oneResourceViolations(project, kind, key, obj(raw)),
    ),
  );
}

function oneResourceViolations(
  project: string,
  kind: "networks" | "volumes",
  key: string,
  r: Json,
): string[] {
  const out: string[] = [];
  const at = `${kind.slice(0, -1)} "${key}"`;
  if (r["external"] !== undefined && r["external"] !== false) {
    out.push(`${at}: external is not allowed`);
  }
  if (typeof r["name"] === "string" && r["name"] !== `${project}_${key}`) {
    out.push(`${at}: a custom name is not allowed`);
  }
  if (kind === "volumes" && Object.keys(obj(r["driver_opts"])).length > 0) {
    out.push(`${at}: driver_opts are not allowed (a bind mount in disguise)`);
  }
  // A volume plugin keeps its data wherever it likes, the host's own disks included.
  if (kind === "volumes" && r["driver"] !== undefined && r["driver"] !== "local") {
    out.push(`${at}: only the local driver is allowed`);
  }
  if (kind === "networks" && r["driver"] !== undefined && r["driver"] !== "bridge") {
    out.push(`${at}: only the bridge driver is allowed`);
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
    ...unknownFields(doc),
    ...serviceViolations(doc, inSource),
    ...inlineOnlyViolations(doc),
    ...resourceViolations(project, doc),
  ];
}

/** Every string inside, keys too: a label's name is image metadata as much as its value. */
function strings(v: unknown): string[] {
  if (typeof v === "string") {
    return [v];
  }
  if (typeof v !== "object" || v === null) {
    return [];
  }
  return [...(Array.isArray(v) ? [] : Object.keys(v)), ...Object.values(v).flatMap(strings)];
}

const MIN_SUBSTRING = 6;

/** Each name in `$NAME`, `${NAME}` or `${NAME:-x}`, but not the escaped `$$NAME`. */
const referenced = (strs: string[]) =>
  new Set(strs.flatMap((s) => [...s.matchAll(/(?<!\$)\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1])));

// A secret in a build lands in the image. `asked` is read with --no-interpolate, so a reference
// is caught at any length; values shorter than MIN_SUBSTRING would match a Dockerfile by chance.
export function buildSecretViolations(
  resolved: Json,
  asked: Json,
  secrets: Record<string, string>,
): string[] {
  const values = Object.entries(secrets);
  const services = new Set([
    ...Object.keys(obj(resolved["services"])),
    ...Object.keys(obj(asked["services"])),
  ]);
  return [...services].flatMap((name) => {
    const built = strings(obj(obj(obj(resolved["services"])[name])["build"]));
    const named = referenced(strings(obj(obj(obj(asked["services"])[name])["build"])));
    return values
      .filter(
        ([key, v]) =>
          named.has(key) ||
          (v !== "" && built.some((s) => s === v || (v.length >= MIN_SUBSTRING && s.includes(v)))),
      )
      .map(
        ([key]) =>
          `service "${name}": build uses the secret ${key} (secrets reach the running container only; read it at runtime)`,
      );
  });
}
