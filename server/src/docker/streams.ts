import { must } from "@gangway/shared/must";
import type { DockerEvent, LogLine, LogStream } from "./client-types.ts";

const DEMUX_HEADER = 8;

// A frame header is a stream type of 0, 1 or 2 followed by three zero bytes.
const isFrameHeader = (buf: Uint8Array): boolean =>
  (buf[0] === 0 || buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;

const streamOf = (type: number): LogStream => (type === 2 ? "stderr" : "stdout");

// Non-TTY logs carry an 8-byte frame header and TTY logs are raw; sniff rather than inspect.
export async function* demultiplex(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<{ stream: LogStream; bytes: Uint8Array }> {
  let buf = new Uint8Array(0);
  const append = (next: Uint8Array) => {
    const merged = new Uint8Array(buf.length + next.length);
    merged.set(buf);
    merged.set(next, buf.length);
    buf = merged;
  };

  for await (const chunk of chunks) {
    append(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    for (;;) {
      const [type] = buf;
      if (type === undefined || buf.length < DEMUX_HEADER) {
        break;
      }
      if (!isFrameHeader(buf)) {
        yield { stream: "stdout", bytes: buf };
        buf = new Uint8Array(0);
        break;
      }
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const size = view.getUint32(4, false);
      if (buf.length < DEMUX_HEADER + size) {
        break;
      }
      yield {
        stream: streamOf(type),
        bytes: buf.slice(DEMUX_HEADER, DEMUX_HEADER + size),
      };
      buf = buf.slice(DEMUX_HEADER + size);
    }
  }
  if (buf.length > 0) {
    yield { stream: "stdout", bytes: buf };
  }
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/s;

export async function* toLogLines(
  frames: AsyncIterable<{ stream: LogStream; bytes: Uint8Array }>,
  timestamps: boolean,
): AsyncGenerator<LogLine> {
  const dec = new TextDecoder();
  const partial: Record<LogStream, string> = { stdout: "", stderr: "" };

  const emit = (stream: LogStream, raw: string): LogLine => {
    if (!timestamps) {
      return { stream, line: raw };
    }
    const m = TS_RE.exec(raw);
    if (!m) {
      return { stream, line: raw };
    }
    const [, stamp, line] = m;
    const at = new Date(must(stamp, "a log timestamp"));
    return Number.isNaN(at.getTime())
      ? { stream, line: raw }
      : { stream, line: must(line, "a log line"), at };
  };

  for await (const frame of frames) {
    const text = partial[frame.stream] + dec.decode(frame.bytes, { stream: true });
    const parts = text.split("\n");
    partial[frame.stream] = parts.pop() ?? "";
    for (const p of parts) {
      yield emit(frame.stream, p.replace(/\r$/, ""));
    }
  }
  for (const stream of ["stdout", "stderr"] as const) {
    const rest = partial[stream];
    if (rest !== "") {
      yield emit(stream, rest);
    }
  }
}

export async function* parseEventStream(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<DockerEvent> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of chunks) {
    buf += dec.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const ev = parseEventLine(line);
      if (ev) {
        yield ev;
      }
      nl = buf.indexOf("\n");
    }
  }
  const last = parseEventLine(buf.trim());
  if (last) {
    yield last;
  }
}

function parseEventLine(line: string): DockerEvent | null {
  if (line === "") {
    return null;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const actor = (raw["Actor"] ?? {}) as { ID?: string; Attributes?: Record<string, string> };
  const nano = typeof raw["timeNano"] === "number" ? raw["timeNano"] : null;
  const secs = typeof raw["time"] === "number" ? raw["time"] : 0;
  return {
    type: typeof raw["Type"] === "string" ? raw["Type"] : "",
    action: typeof raw["Action"] === "string" ? raw["Action"] : "",
    id: typeof raw["id"] === "string" ? raw["id"] : (actor.ID ?? ""),
    actor: { id: actor.ID ?? "", attributes: actor.Attributes ?? {} },
    time: new Date(nano === null ? secs * 1000 : nano / 1e6),
  };
}
