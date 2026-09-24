import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const ROOTS = ["server/src", "shared/src", "web/src", "render/src", "scripts"];
const MAX_FILE_SHARE = 0.05;
const ALLOWED_PER_FILE = 2;
const MAX_TOTAL_SHARE = 0.02;

function commentLines(file: string, text: string): number {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const record = (range: ts.CommentRange) => {
    const comment = text.slice(range.pos, range.end);
    if (/^\/\/\s*(eslint-|@ts-|prettier-)/.test(comment)) return;
    const first = source.getLineAndCharacterOfPosition(range.pos).line;
    const last = source.getLineAndCharacterOfPosition(range.end).line;
    for (let line = first; line <= last; line++) lines.add(line);
  };
  const visit = (node: ts.Node) => {
    ts.getLeadingCommentRanges(text, node.getFullStart())?.forEach(record);
    ts.getTrailingCommentRanges(text, node.getEnd())?.forEach(record);
    node.getChildren(source).forEach(visit);
  };
  visit(source);
  return lines.size;
}

const files = execFileSync("git", ["ls-files", ...ROOTS], { encoding: "utf8" })
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
  if (n > ALLOWED_PER_FILE && n / lines > MAX_FILE_SHARE) offenders.push(`${file}: ${n}/${lines}`);
}

const share = comments / total;
console.log(`${comments} comment lines in ${total} (${(share * 100).toFixed(1)}%)`);
for (const o of offenders) console.log(`too many comments: ${o}`);
if (offenders.length > 0 || share > MAX_TOTAL_SHARE) process.exit(1);
