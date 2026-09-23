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

export function allocatePort(range: PortRange, used: ReadonlySet<number>, host = "host"): number {
  for (let p = range.rangeStart; p <= range.rangeEnd; p++) {
    if (!used.has(p)) return p;
  }
  throw new PortExhausted(host, range);
}

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

export function assertInRange(port: number, range: PortRange, host = "host"): void {
  if (!isInRange(port, range)) {
    throw new AppError(
      "internal",
      `port ${port} is outside host ${host}'s pool ${range.rangeStart}-${range.rangeEnd}`,
    );
  }
}
