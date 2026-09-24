const UNIT: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** Docker's memory notation (`512m`, `2g`, a plain byte count) to bytes; null when it is not one. */
export function parseBytes(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  if (typeof v !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmg]?)b?\s*$/i.exec(v);
  if (!m) return null;
  return Math.floor(Number(m[1]) * (UNIT[(m[2] ?? "").toLowerCase()] ?? 1));
}
