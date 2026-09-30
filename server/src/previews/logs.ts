import { must } from "@gangway/shared/must";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { redactString } from "../logger.ts";
import { isUlid } from "../util/ulid.ts";

export const LOG_STREAMS = ["system", "build", "seed", "stdout", "stderr"] as const;
export type LogStream = (typeof LOG_STREAMS)[number];
export type LogLine = { n: number; ts: number; stream: LogStream; line: string };
export type LogListener = (l: LogLine) => void;

const MAX_LINE = 8 * 1024;
const CHUNK = 64 * 1024;
/** A log past this is cut to its newest half; line numbers carry on from where they were. */
const MAX_FILE = 16 * 1024 * 1024;

function parse(row: string): LogLine | null {
  try {
    return JSON.parse(row) as LogLine;
  } catch {
    // a torn final line after a crash
    return null;
  }
}

/** The newest lines of a JSONL file, oldest first, reading back from the end only as far as `enough` needs. */
function readBack(path: string, enough: (got: readonly LogLine[]) => boolean): LogLine[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    let pos = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    const got: LogLine[] = [];
    while (pos > 0 && !enough(got)) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      const joined = Buffer.concat([buf, carry]);
      const cut = pos === 0 ? -1 : joined.indexOf(10);
      carry = cut === -1 ? Buffer.alloc(0) : joined.subarray(0, cut);
      const rows = joined
        .subarray(cut + 1)
        .toString("utf8")
        .split("\n");
      const parsed = rows.flatMap((r) => (r === "" ? [] : [parse(r)].filter((l) => l !== null)));
      got.unshift(...parsed);
    }
    return got;
  } finally {
    closeSync(fd);
  }
}

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
    if (!isUlid(previewId)) {
      throw new Error(`not a preview id: ${JSON.stringify(previewId)}`);
    }
    return join(this.#dir, `${previewId}.jsonl`);
  }

  append(previewId: string, stream: LogStream, text: string): void {
    const path = this.#path(previewId);
    let n = this.#next.get(previewId) ?? (readBack(path, (g) => g.length > 0).at(-1)?.n ?? 0) + 1;
    const out: LogLine[] = [];
    for (const raw of text.split(/\r?\n|\r/)) {
      if (raw === "") {
        continue;
      }
      const clipped = raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)} [truncated]` : raw;
      out.push({
        n: n++,
        ts: this.#now(),
        stream,
        line: redactString(this.#masked(previewId, clipped)),
      });
    }
    if (out.length === 0) {
      return;
    }
    this.#next.set(previewId, n);
    appendFileSync(path, out.map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (statSync(path).size > MAX_FILE) {
      this.#trim(path);
    }
    const ls = this.#listeners.get(previewId);
    if (ls) {
      for (const line of out) {
        for (const l of ls) {
          try {
            l(line);
          } catch {
            // one bad listener must not stop the others
          }
        }
      }
    }
  }

  mask(previewId: string, values: readonly string[]): void {
    const keep = values.filter((v) => v.length >= 8);
    if (keep.length > 0) {
      this.#masks.set(previewId, [...new Set([...(this.#masks.get(previewId) ?? []), ...keep])]);
    }
  }

  #masked(previewId: string, line: string): string {
    const masks = this.#masks.get(previewId);
    if (!masks) {
      return line;
    }
    let out = line;
    for (const m of masks) {
      out = out.split(m).join("[redacted]");
    }
    return out;
  }

  #trim(path: string): void {
    const text = readFileSync(path, "utf8");
    const from = text.indexOf("\n", Math.floor(text.length / 2)) + 1;
    writeFileSync(`${path}.tmp`, text.slice(from));
    renameSync(`${path}.tmp`, path);
  }

  read(previewId: string, afterLine = 0, last = Infinity): LogLine[] {
    const path = this.#path(previewId);
    if (!existsSync(path)) {
      return [];
    }
    const done = (g: readonly LogLine[]) => {
      const [first] = g;
      return g.length > last || (first !== undefined && first.n <= afterLine);
    };
    return readBack(path, done).filter((l) => l.n > afterLine);
  }

  tail(previewId: string, count = 50): string[] {
    return this.read(previewId, 0, count)
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
    if (!set) {
      this.#listeners.set(previewId, (set = new Set()));
    }
    set.add(emit);

    const keep = Math.max(1, Math.min(o.tail ?? Infinity, o.maxReplay ?? Infinity));
    let backlog = this.read(previewId, cursor, keep);
    if (backlog.length > keep) {
      backlog = backlog.slice(-keep);
      const first = must(backlog[0], "a backlog line");
      const skipped = first.n - 1 - cursor;
      emit({
        n: first.n - 1,
        ts: first.ts,
        stream: "system",
        line: `... ${skipped} earlier line${skipped === 1 ? "" : "s"} not shown`,
      });
    }
    for (const l of backlog) {
      emit(l);
    }
    return () => {
      set.delete(emit);
      if (set.size === 0) {
        this.#listeners.delete(previewId);
      }
    };
  }

  remove(previewId: string): void {
    rmSync(this.#path(previewId), { force: true });
    this.#next.delete(previewId);
    this.#masks.delete(previewId);
  }
}
