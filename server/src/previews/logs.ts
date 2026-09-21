/**
 * Per-preview logs: build output, compose stderr, pipeline steps. One JSONL file per
 * preview under `<state>/logs/`, numbered lines, live fan-out.
 *
 * NOT the events table: a build emits thousands of lines, and events are the low-volume
 * state stream every UI tab replays on reconnect. The line number is the SSE id, so
 * `Last-Event-ID` resumes a log exactly where the browser lost it.
 *
 * Every line is redacted on the way IN -- these go to disk, to SSE clients and into the
 * proxy's failure page (§6.1), and a clone URL with an installation token is one
 * `git fetch` error away.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { redactString } from "../logger.ts";
import { isUlid } from "../util/ulid.ts";

export type LogStream = "system" | "build" | "stdout" | "stderr";
export type LogLine = { n: number; ts: number; stream: LogStream; line: string };
export type LogListener = (l: LogLine) => void;

const MAX_LINE = 8 * 1024;

export class PreviewLogs {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #next = new Map<string, number>();
  readonly #listeners = new Map<string, Set<LogListener>>();

  constructor(stateDir: string, now: () => number = Date.now) {
    this.#dir = join(stateDir, "logs");
    this.#now = now;
    mkdirSync(this.#dir, { recursive: true });
  }

  #path(previewId: string): string {
    // The id reaches here from a URL parameter. It names a file.
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
      out.push({ n: n++, ts: this.#now(), stream, line: redactString(clipped) });
    }
    if (out.length === 0) return;
    this.#next.set(previewId, n);
    appendFileSync(path, out.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const ls = this.#listeners.get(previewId);
    if (ls) for (const line of out) for (const l of ls) { try { l(line); } catch { /* one bad client */ } }
  }

  /** Lines with n > afterLine. */
  read(previewId: string, afterLine = 0): LogLine[] {
    const path = this.#path(previewId);
    if (!existsSync(path)) return [];
    const out: LogLine[] = [];
    for (const row of readFileSync(path, "utf8").split("\n")) {
      if (row === "") continue;
      try {
        const l = JSON.parse(row) as LogLine;
        if (l.n > afterLine) out.push(l);
      } catch { /* a torn final line after a crash */ }
    }
    return out;
  }

  /** The proxy's failure page shows these (§6.1: "502 + last 50 log lines"). */
  tail(previewId: string, count = 50): string[] {
    return this.read(previewId).slice(-count).map((l) => l.line);
  }

  follow(previewId: string, afterLine: number, deliver: LogListener): () => void {
    let cursor = afterLine;
    const emit = (l: LogLine) => { if (l.n > cursor) { cursor = l.n; deliver(l); } };
    let set = this.#listeners.get(previewId);
    if (!set) this.#listeners.set(previewId, (set = new Set()));
    set.add(emit);
    for (const l of this.read(previewId, cursor)) emit(l);
    return () => {
      set.delete(emit);
      if (set.size === 0) this.#listeners.delete(previewId);
    };
  }

  /** §15.4 default: discard on destroy. */
  remove(previewId: string): void {
    rmSync(this.#path(previewId), { force: true });
    this.#next.delete(previewId);
  }
}
