import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = "server/test/timings.json";
const dir = mkdtempSync(join(tmpdir(), "gangway-timings-"));
const report = join(dir, "junit.xml");

try {
  execFileSync(
    "bun",
    ["test", "--reporter=junit", `--reporter-outfile=${report}`, "server/test/unit", "shared/test"],
    { stdio: "ignore" },
  );
  const files: Record<string, number> = {};
  for (const m of readFileSync(report, "utf8").matchAll(/<testcase [^>]*>/g)) {
    const file = /file="([^"]+)"/.exec(m[0])?.[1];
    const time = Number(/time="([^"]+)"/.exec(m[0])?.[1] ?? 0);
    if (file) files[file] = (files[file] ?? 0) + time * 1000;
  }
  const sorted = Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, ms]): [string, number] => [file, Math.round(ms)]);
  writeFileSync(
    OUT,
    `${JSON.stringify({ version: 1, files: Object.fromEntries(sorted) }, null, 2)}\n`,
  );
  console.log(`wrote ${OUT} (${sorted.length} files)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
