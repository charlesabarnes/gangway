/**
 * Upstream port allocation (ADR-0004).
 *
 * We allocate the published port ourselves rather than publishing `0:<port>` and reading
 * back what Docker chose. §5 requires the route row to exist BEFORE containers start, and
 * container labels are fixed at create time -- so a port we do not yet know could be in
 * neither. Allocating first makes the row and the label both complete before `compose up`.
 *
 * There is no separate allocator state to drift or leak: the routes table IS the ledger,
 * and a UNIQUE(upstream_host, upstream_port) index turns a double allocation into a
 * constraint violation rather than a silent conflict.
 */
import { AppError } from "../errors.ts";

export type PortRange = { rangeStart: number; rangeEnd: number };

export class PortExhausted extends AppError {
  constructor(host: string, range: PortRange) {
    super(
      "unavailable",
      `no free upstream port on ${host} in ${range.rangeStart}-${range.rangeEnd}`,
    );
    this.name = "PortExhausted";
  }
}

/**
 * Picks the lowest free port in the range. Deterministic rather than random: a predictable
 * port makes a preview's mapping reproducible across recreation, which is what lets a
 * container come back on the same port instead of needing an UpdateUpstream pass.
 */
export function allocatePort(range: PortRange, used: ReadonlySet<number>, host = "host"): number {
  for (let p = range.rangeStart; p <= range.rangeEnd; p++) {
    if (!used.has(p)) return p;
  }
  throw new PortExhausted(host, range);
}

/** Allocates several distinct ports at once, for a multi-service stack. */
export function allocatePorts(
  range: PortRange,
  used: ReadonlySet<number>,
  count: number,
  host = "host",
): number[] {
  const taken = new Set(used);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = allocatePort(range, taken, host);
    taken.add(p);
    out.push(p);
  }
  return out;
}

export function isInRange(port: number, range: PortRange): boolean {
  return port >= range.rangeStart && port <= range.rangeEnd;
}

/**
 * Guard used at every allocation site. A port outside the host's configured pool is a bug,
 * never a fallback -- silently drifting outside the range is how a preview ends up
 * colliding with the operator's real workloads.
 */
export function assertInRange(port: number, range: PortRange, host = "host"): void {
  if (!isInRange(port, range)) {
    throw new AppError(
      "internal",
      `port ${port} is outside host ${host}'s pool ${range.rangeStart}-${range.rangeEnd}`,
    );
  }
}
