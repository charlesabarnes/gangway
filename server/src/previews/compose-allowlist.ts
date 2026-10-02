import { obj, type Json } from "../util/json.ts";

// What a preview's compose file may say, after `compose config` has resolved it. Anything else is
// refused by name, so a field a newer Compose adds stays out until someone decides it is safe.
// Fields here may still have their values checked in compose-policy.ts.

const TOP = new Set(["name", "services", "networks", "volumes", "secrets", "configs"]);

const SERVICE = new Set([
  "attach",
  "build",
  "cap_drop",
  "command",
  "configs",
  "cpu_count",
  "cpu_percent",
  "cpu_period",
  "cpu_quota",
  "cpu_shares",
  "cpus",
  "cpuset",
  "depends_on",
  "deploy",
  "develop",
  "domainname",
  "entrypoint",
  "env_file",
  "environment",
  "expose",
  "extends",
  "group_add",
  "healthcheck",
  "hostname",
  "image",
  "init",
  "isolation",
  "label_file",
  "labels",
  "links",
  "mem_limit",
  "mem_reservation",
  "mem_swappiness",
  "memswap_limit",
  "network_mode",
  "networks",
  "oom_score_adj",
  "pids_limit",
  "platform",
  "ports",
  "post_start",
  "pre_stop",
  "profiles",
  "pull_policy",
  "read_only",
  "restart",
  "runtime",
  "scale",
  "secrets",
  "shm_size",
  "stdin_open",
  "stop_grace_period",
  "stop_signal",
  "tmpfs",
  "tty",
  "ulimits",
  "user",
  "volumes",
  "volumes_from",
  "working_dir",
]);

const BUILD = new Set([
  "context",
  "dockerfile",
  "dockerfile_inline",
  "args",
  "target",
  "labels",
  "shm_size",
  "platforms",
  "tags",
  "pull",
  "no_cache",
  "network",
  "isolation",
  "provenance",
  "sbom",
]);

const DEPLOY = new Set(["mode", "replicas", "labels", "resources", "restart_policy"]);
const LIMITS = new Set(["cpus", "memory", "pids"]);
const RESERVATIONS = new Set(["cpus", "memory"]);
const MOUNT = new Set(["type", "source", "target", "read_only", "volume", "tmpfs", "consistency"]);
const SERVICE_NETWORK = new Set([
  "aliases",
  "ipv4_address",
  "ipv6_address",
  "priority",
  "gw_priority",
]);

const NETWORK = new Set([
  "name",
  "driver",
  "external",
  "labels",
  "internal",
  "attachable",
  "enable_ipv4",
  "enable_ipv6",
  "ipam",
]);
const VOLUME = new Set(["name", "driver", "driver_opts", "external", "labels"]);
// file, environment and external are refused with a reason of their own in compose-policy.ts.
const SECRET = new Set(["content", "name", "labels", "file", "environment", "external"]);

const REASONS: Record<string, string> = {
  container_name: "it defeats per-preview namespacing",
  logging: "gangway reads the logs; a driver would send them elsewhere",
  ipam: "the engine picks the addresses",
};

function unknown(at: string, v: unknown, allowed: ReadonlySet<string>): string[] {
  return Object.entries(obj(v))
    .filter(([k, val]) => !allowed.has(k) && !k.startsWith("x-") && val !== null)
    .map(([k]) => k)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => {
      const reason = REASONS[k];
      return reason ? `${at}${k} is not allowed (${reason})` : `${at}${k} is not allowed`;
    });
}

const entries = (v: unknown): [string, unknown][] =>
  Array.isArray(v) ? [] : Object.entries(obj(v));

function serviceFields(name: string, raw: unknown): string[] {
  const at = `service "${name}": `;
  const s = obj(raw);
  const resources = obj(obj(s["deploy"])["resources"]);
  return [
    ...unknown(at, s, SERVICE),
    ...unknown(`${at}build.`, typeof s["build"] === "object" ? s["build"] : {}, BUILD),
    ...unknown(`${at}deploy.`, s["deploy"], DEPLOY),
    ...unknown(`${at}deploy.resources.`, resources, new Set(["limits", "reservations"])),
    ...unknown(`${at}deploy.resources.limits.`, resources["limits"], LIMITS),
    ...unknown(`${at}deploy.resources.reservations.`, resources["reservations"], RESERVATIONS),
    ...(Array.isArray(s["volumes"]) ? s["volumes"] : []).flatMap((m) =>
      unknown(`${at}volumes: `, m, MOUNT),
    ),
    ...entries(s["networks"]).flatMap(([n, cfg]) =>
      unknown(`${at}networks.${n}.`, cfg, SERVICE_NETWORK),
    ),
  ];
}

// `compose config` writes `ipam: {}` on every network; anything inside it is asking for addresses.
const emptyIpam = (r: Json) => Object.keys(obj(r["ipam"])).length === 0;

export function unknownFields(doc: Json): string[] {
  const resource = (kind: string, allowed: ReadonlySet<string>) =>
    entries(doc[kind]).flatMap(([key, raw]) => {
      const r = obj(raw);
      const at = `${kind.slice(0, -1)} "${key}": `;
      const ipam =
        kind === "networks" && !emptyIpam(r)
          ? [`${at}ipam is not allowed (${REASONS["ipam"]})`]
          : [];
      return [...unknown(at, kind === "networks" ? { ...r, ipam: null } : r, allowed), ...ipam];
    });
  return [
    ...unknown("", doc, TOP),
    ...entries(doc["services"]).flatMap(([name, raw]) => serviceFields(name, raw)),
    ...resource("networks", NETWORK),
    ...resource("volumes", VOLUME),
    ...resource("secrets", SECRET),
    ...resource("configs", SECRET),
  ];
}
