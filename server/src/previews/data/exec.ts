import { addonById, type AddonId } from "@gangway/shared/addons";
import type { Host, Preview } from "@gangway/shared/domain";
import { AppError, conflict, unprocessable } from "../../errors.ts";
import type { PreviewContext } from "../context.ts";
import { MAX_ROWS, parse, queryArgv, type QueryResult } from "./drivers.ts";

export const WALL_CLOCK_MS = 20_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type TimedResult = QueryResult & { ms: number };

export type Exec = {
  ctx: PreviewContext;
  preview: Preview;
  host: Host;
  addon: AddonId;
  cwd: string;
  abort: AbortController;
  outcome: string;
};

export async function findContainer(x: Exec): Promise<string> {
  const docker = x.ctx.docker ?? "docker";
  const service = addonById(x.addon).service;
  const ps = await x.ctx.compose.capture(
    [
      docker,
      "ps",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${x.preview.project}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
    ],
    x.host,
    { cwd: x.cwd },
  );
  const container = ps.stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^[0-9a-f]{12,64}$/.test(l));
  if (ps.code !== 0 || !container) {
    x.outcome = "not running";
    throw conflict(`the ${addonById(x.addon).name} container is not running`);
  }
  return container;
}

type Output = { out: string[]; err: string[]; truncated: boolean; code: number };

export async function execQuery(
  x: Exec,
  container: string,
  text: string,
  write: boolean,
): Promise<Output> {
  const docker = x.ctx.docker ?? "docker";
  const o: Output = { out: [], err: [], truncated: false, code: -1 };
  let bytes = 0;
  for await (const ev of x.ctx.compose.stream(
    [docker, "exec", container, ...queryArgv(x.addon, text, write)],
    x.host,
    { cwd: x.cwd, signal: x.abort.signal },
  )) {
    if (ev.type === "exit") {
      o.code = ev.code;
      break;
    }
    bytes += ev.line.length + 1;
    if (bytes > MAX_OUTPUT_BYTES) {
      o.truncated = true;
      x.abort.abort();
      break;
    }
    (ev.stream === "stdout" ? o.out : o.err).push(ev.line);
  }
  return o;
}

export function toResult(x: Exec, o: Output, ms: number): TimedResult {
  if (!o.truncated && x.abort.signal.aborted) {
    x.outcome = "timeout";
    throw new AppError(
      "unavailable",
      `the query ran longer than ${WALL_CLOCK_MS / 1000}s and was stopped`,
    );
  }
  if (!o.truncated && o.code !== 0) {
    x.outcome = "error";
    throw unprocessable(
      o.err.join("\n").trim().slice(-2_000) || `${addonById(x.addon).name} exited ${o.code}`,
    );
  }
  const parsed = parse(x.addon, o.out.join("\n"));
  const rows = parsed.rows.slice(0, MAX_ROWS);
  return {
    columns: parsed.columns,
    rows,
    ms,
    truncated: o.truncated || parsed.rows.length > MAX_ROWS,
    message: o.err.join("\n").trim().slice(-500) || null,
  };
}
