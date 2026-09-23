import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { redactString } from "../logger.ts";
import { isUlid } from "../util/ulid.ts";

export const LOG_STREAMS = ["system", "build", "seed", "stdout", "stderr"] as const;
export type LogStream = (typeof LOG_STREAMS)[number];
export type LogLine = { n: number; ts: number; stream: LogStream; line: string };
export type LogListener = (l: LogLine) => void;

const MAX_LINE = 8 * 1024;

export class PreviewLogs {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #next = new Map<string, number>();
  readonly #listeners = new Map<string, Set<LogListener>>();
  readonly #masks = new Map<string, string[]>();

  constructor(stateDir: string, now: () => number = Date.now) {
    this.#dir = join(stateDir, "logs");
    this.#now = now;
    mkdirSync(this.#dir, { recursive: true });
  }

  #path(previewId: string): string {
    if (!isUlid(previewId)) throw new Error(`not a preview id: ${JSON.stringify(previewId)}`);
    return join(this.#dir, `${previewId}.jsonl`);
  }

  append(previewId: string, stream: LogStream, text: string): void {
    const path = this.#path(previewId);
    let n = this.#next.get(previewId) ?? this.read(previewId).length + 1;
    const out: LogLine[] = [];
    for (const raw of text.split(/\r?\n|\r/)) {
      if (raw === "") continue;
      const clipped = raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)} [truncated]` : raw;
      out.push({
        n: n++,
        ts: this.#now(),
        stream,
        line: redactString(this.#masked(previewId, clipped)),
      });
    }
    if (out.length === 0) return;
    this.#next.set(previewId, n);
    appendFileSync(path, out.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const ls = this.#listeners.get(previewId);
    if (ls)
      for (const line of out)
        for (const l of ls) {
          try {
            l(line);
          } catch {
            // one bad listener must not stop the others
          }
        }
  }

  mask(previewId: string, values: readonly string[]): void {
    const keep = values.filter((v) => v.length >= 8);
    if (keep.length > 0)
      this.#masks.set(previewId, [...new Set([...(this.#masks.get(previewId) ?? []), ...keep])]);
  }

  #masked(previewId: string, line: string): string {
    const masks = this.#masks.get(previewId);
    if (!masks) return line;
    let out = line;
    for (const m of masks) out = out.split(m).join("[redacted]");
    return out;
  }

  read(previewId: string, afterLine = 0): LogLine[] {
    const path = this.#path(previewId);
    if (!existsSync(path)) return [];
    const out: LogLine[] = [];
    for (const row of readFileSync(path, "utf8").split("\n")) {
      if (row === "") continue;
      try {
        const l = JSON.parse(row) as LogLine;
        if (l.n > afterLine) out.push(l);
      } catch {
        // a torn final line after a crash
      }
    }
    return out;
  }

  tail(previewId: string, count = 50): string[] {
    return this.read(previewId)
      .slice(-count)
      .map((l) => l.line);
  }

  follow(
    previewId: string,
    afterLine: number,
    deliver: LogListener,
    o: { tail?: number | undefined; maxReplay?: number | undefined } = {},
  ): () => void {
    let cursor = afterLine;
    const emit = (l: LogLine) => {
      if (l.n > cursor) {
        cursor = l.n;
        deliver(l);
      }
    };
    let set = this.#listeners.get(previewId);
    if (!set) this.#listeners.set(previewId, (set = new Set()));
    set.add(emit);

    let backlog = this.read(previewId, cursor);
    const keep = Math.max(1, Math.min(o.tail ?? Infinity, o.maxReplay ?? Infinity));
    const skipped = backlog.length - keep;
    if (skipped > 0) {
      backlog = backlog.slice(-keep);
      const first = backlog[0]!;
      emit({
        n: first.n - 1,
        ts: first.ts,
        stream: "system",
        line: `... ${skipped} earlier line${skipped === 1 ? "" : "s"} not shown`,
      });
    }
    for (const l of backlog) emit(l);
    return () => {
      set.delete(emit);
      if (set.size === 0) this.#listeners.delete(previewId);
    };
  }

  remove(previewId: string): void {
    rmSync(this.#path(previewId), { force: true });
    this.#next.delete(previewId);
    this.#masks.delete(previewId);
  }
}
