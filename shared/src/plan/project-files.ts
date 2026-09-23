import { isRelPath } from "../gangway-file.ts";
import type { Reason } from "./types.ts";

export type Json = Record<string, unknown>;

export function readJson(text: string | undefined, name: string, reasons: Reason[]): Json | null {
  if (text === undefined) return null;
  try {
    const v = JSON.parse(name.endsWith("c") ? text.replace(/^\s*\/\/.*$/gm, "") : text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Json;
  } catch {}
  reasons.push({
    level: "error",
    found: `${name} is not valid JSON`,
    then: "fix it, or the install step would fail anyway",
  });
  return null;
}

export const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

export function entryFrom(have: Set<string>, rel: unknown): string | null {
  if (typeof rel !== "string" || rel === "") return null;
  const parts: string[] = [];
  for (const seg of rel.replace(/^\.\//, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const norm = parts.join("/");
  return isRelPath(norm) && have.has(norm) ? norm : null;
}
