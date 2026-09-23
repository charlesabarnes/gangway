import type { Command } from "../gangway-file.ts";

export const cmdText = (c: Command): string =>
  typeof c === "string" ? c : c.map(shellQuote).join(" ");
const shellQuote = (s: string): string =>
  /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
