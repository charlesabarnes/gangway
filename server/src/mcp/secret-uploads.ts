// A one-use URL an agent PUTs a dotenv file to, so secret values reach gangway without passing
// through the agent's conversation. Held in memory only, never on disk, and gone once used.
import { randomBytes } from "node:crypto";
import { must } from "@gangway/shared/must";
import { actorId, type Actor } from "../auth/actor.ts";
import { AppError, conflict, notFound, unprocessable } from "../errors.ts";
import { ENV_NAME_RE } from "../secrets/secrets.ts";

const TTL_MS = 10 * 60_000;
export const MAX_SECRET_UPLOAD_BYTES = 64 * 1024;
const MAX_PER_OWNER = 5;
const MAX_PENDING = 50;
const ID = /^[A-Za-z0-9_-]{43}$/;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

type Slot = {
  owner: string;
  expiresAt: number;
  values: Record<string, string> | null;
};

export type SecretUploadIssued = { id: string; url: string; expiresAt: number };

/** KEY=value lines; `export`, comments, blank lines and single or double quotes as in .env. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = must(lines[i], "a line").trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      throw unprocessable(`line ${i + 1} is not NAME=value`);
    }
    const name = must(m[1], "a variable name");
    if (!ENV_NAME_RE.test(name)) {
      throw unprocessable(`line ${i + 1}: "${name}" is not a valid environment variable name`);
    }
    let value = must(m[2], "a value");
    const q = value[0];
    if (q === '"' || q === "'") {
      // A quoted value may run over several lines, up to its closing quote.
      let body = value.slice(1);
      while (!endsQuoted(body, q) && i + 1 < lines.length) {
        body += `\n${lines[++i]}`;
      }
      if (!endsQuoted(body, q)) {
        throw unprocessable(`line ${i + 1}: the ${q} quote is not closed`);
      }
      body = body.replace(/\s*$/, "").slice(0, -1);
      value = q === '"' ? body.replace(/\\(["\\nrt$])/g, (_, c: string) => ESCAPES[c] ?? c) : body;
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[name] = value;
  }
  return out;
}

function endsQuoted(body: string, q: string): boolean {
  const t = body.replace(/\s*$/, "");
  if (!t.endsWith(q)) {
    return false;
  }
  let backslashes = 0;
  for (let j = t.length - 2; j >= 0 && t[j] === "\\"; j--) {
    backslashes++;
  }
  return q === "'" || backslashes % 2 === 0;
}

export class SecretUploads {
  readonly #url: (id: string) => string;
  readonly #now: () => number;
  readonly #slots = new Map<string, Slot>();

  constructor(o: { url: (id: string) => string; now?: () => number }) {
    this.#url = o.url;
    this.#now = o.now ?? Date.now;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, s] of this.#slots) {
      if (s.expiresAt <= now) {
        this.#slots.delete(id);
      }
    }
  }

  issue(actor: Actor): SecretUploadIssued {
    this.#sweep();
    const owner = actorId(actor);
    if ([...this.#slots.values()].filter((s) => s.owner === owner).length >= MAX_PER_OWNER) {
      throw new AppError(
        "rate_limited",
        `${MAX_PER_OWNER} secret uploads are already waiting for this credential; use them or let them expire`,
      );
    }
    if (this.#slots.size >= MAX_PENDING) {
      throw new AppError("rate_limited", "too many secret uploads are waiting; try again soon");
    }
    const id = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + TTL_MS;
    this.#slots.set(id, { owner, expiresAt, values: null });
    return { id, url: this.#url(id), expiresAt };
  }

  /** Parses the body at once; only the names are ever answered. */
  async receive(id: string, body: ReadableStream<Uint8Array> | null): Promise<string[]> {
    this.#sweep();
    const slot = ID.test(id) ? this.#slots.get(id) : undefined;
    if (!slot) {
      throw notFound('no such secret upload, or it expired; ask for a new one with upload: "new"');
    }
    if (slot.values !== null) {
      throw conflict("this secret upload was already used");
    }
    if (!body) {
      throw unprocessable("send the dotenv file as the request body");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_SECRET_UPLOAD_BYTES) {
        throw new AppError("payload_too_large", `at most ${MAX_SECRET_UPLOAD_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
    const values = parseDotenv(Buffer.concat(chunks).toString("utf8"));
    if (Object.keys(values).length === 0) {
      throw unprocessable("the file holds no NAME=value lines");
    }
    slot.values = values;
    return Object.keys(values).sort();
  }

  /** The values, once: the slot is gone after this. */
  take(id: string, actor: Actor): Record<string, string> {
    this.#sweep();
    const slot = ID.test(id) ? this.#slots.get(id) : undefined;
    if (slot?.owner !== actorId(actor)) {
      throw notFound("no such secret upload for this credential, or it expired; ask for a new one");
    }
    if (slot.values === null) {
      throw conflict(`nothing has been sent yet; PUT the file to ${this.#url(id)} first`);
    }
    this.#slots.delete(id);
    return slot.values;
  }
}
