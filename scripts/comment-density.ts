import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseSync } from "oxc-parser";

const ROOTS = ["server/src", "shared/src", "web/src", "render/src", "scripts"];
const MAX_FILE_SHARE = 0.05;
const ALLOWED_PER_FILE = 2;
const MAX_TOTAL_SHARE = 0.02;

function commentLines(file: string, text: string): number {
  const lineOf = (pos: number) => text.slice(0, pos).split("\n").length - 1;
  const lines = new Set<number>();
  const { comments, errors } = parseSync(file, text);
  // A parse error stops oxc early, and the comments after it would go uncounted.
  if (errors.length > 0) {
    throw new Error(`${file}: ${errors[0]?.message ?? "does not parse"}`);
  }
  for (const { start, end } of comments) {
    if (/^\/\/\s*(eslint-|@ts-|prettier-|codeql\[|NOSONAR)/.test(text.slice(start, end))) {
      continue;
    }
    for (let line = lineOf(start); line <= lineOf(end); line++) {
      lines.add(line);
    }
  }
  return lines.size;
}

const files = execFileSync("git", ["ls-files", ...ROOTS], { encoding: "utf8" }) // NOSONAR a dev script run with the developer's own PATH
  .split("\n")
  .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".spec.ts"));

let total = 0;
let comments = 0;
const offenders: string[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n").length;
  const n = commentLines(file, text);
  total += lines;
  comments += n;
  if (n > ALLOWED_PER_FILE && n / lines > MAX_FILE_SHARE) {
    offenders.push(`${file}: ${n}/${lines}`);
  }
}

const share = comments / total;
console.log(`${comments} comment lines in ${total} (${(share * 100).toFixed(1)}%)`);
for (const o of offenders) {
  console.log(`too many comments: ${o}`);
}
if (offenders.length > 0 || share > MAX_TOTAL_SHARE) {
  process.exit(1);
}
