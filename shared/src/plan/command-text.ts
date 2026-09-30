import type { Command } from "../gangway-file.ts";

export const cmdText = (c: Command): string =>
  typeof c === "string" ? c : c.map(shellQuote).join(" ");
const shellQuote = (s: string): string => {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) {
    return s;
  }
  const escaped = s.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
};
