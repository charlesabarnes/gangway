import { obj, type Json } from "../util/json.ts";

const count = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
};

/** The containers one service starts: `scale` or `deploy.replicas`, whichever asks for more. */
export function replicasOf(s: Json): number {
  const asked = [count(s["scale"]), count(obj(s["deploy"])["replicas"])].filter(
    (n): n is number => n !== null,
  );
  return asked.length === 0 ? 1 : Math.max(...asked);
}

/**
 * Every container is capped on its own, so the number of them is what bounds a preview as a
 * whole: replicas multiply the memory and processes it may take. 0 leaves it off.
 */
export function sizeViolations(doc: Json, maxContainers: number): string[] {
  if (maxContainers <= 0) {
    return [];
  }
  const services = Object.entries(obj(doc["services"]));
  const total = services.reduce((n, [, raw]) => n + replicasOf(obj(raw)), 0);
  if (total <= maxContainers) {
    return [];
  }
  const many = services
    .filter(([, raw]) => replicasOf(obj(raw)) > 1)
    .map(
      ([name, raw]) =>
        `service "${name}": ${replicasOf(obj(raw))} replicas (scale / deploy.replicas)`,
    );
  return [
    `services: ${total} containers across ${services.length} services, more than the ${maxContainers} a preview may run (previews.limits.containers)`,
    ...many,
  ];
}
