/**
 * `Idempotency-Key` (§10.1) -- and, in Phase 5, the MCP `deploy` tool's key (§10.2):
 * "Agents retry. Without a key, three retries means three previews and three URLs."
 *
 * In the service layer, not the REST adapter, so both get the same semantics (ADR-0003):
 *
 *   same key, same request     -> the preview that request already made, as it is NOW
 *                                 (still building, awake, or failed -- a failure is
 *                                 replayed too; a retry is not a redeploy)
 *   same key, other request    -> 422. The caller has a bug; guessing which it meant is worse.
 *   same key, preview destroyed-> the key is free again
 *   same key, at the same time -> one deploy; every caller gets its result
 *
 * A deploy that is REJECTED (422, 409) records nothing: there is no preview to return,
 * and the retry deserves the same honest error.
 */
import { createHash } from "node:crypto";
import type { IdempotencyRepo } from "../db/repos/idempotency.ts";
import { AppError, badRequest } from "../errors.ts";
import { SingleFlight } from "../util/async.ts";
import type { PreviewContext } from "./context.ts";
import { deploy, urlsFor, type DeployInput, type DeployResult } from "./deploy.ts";

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

/** Visible ASCII, 1-255: it is a header value and half of a primary key. */
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Key order must not matter: two JSON encoders may disagree about it. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * An archive cannot be hashed without buffering up to half a gigabyte, so a tarball is
 * fingerprinted by its options plus whatever the adapter knows cheaply (`digest`: the
 * Content-Length). The mismatch check is a guard against caller bugs, not an integrity check.
 */
export const requestHash = ({ actor: _actor, ...request }: DeployInput): string => {
  const source = request.source.kind === "tarball" ? { ...request.source, archive: undefined } : request.source;
  return createHash("sha256").update(canonical({ ...request, source })).digest("hex");
};

export type IdempotentResult = DeployResult & { replayed: boolean };

export class IdempotentDeploys {
  readonly #ctx: PreviewContext;
  readonly #keys: IdempotencyRepo;
  readonly #flight = new SingleFlight<DeployResult>();

  constructor(ctx: PreviewContext, keys: IdempotencyRepo) {
    this.#ctx = ctx;
    this.#keys = keys;
  }

  async deploy(input: DeployInput, key: string | undefined): Promise<IdempotentResult> {
    if (key === undefined) return { ...(await deploy(this.#ctx, input)), replayed: false };
    if (!KEY_RE.test(key)) throw badRequest("Idempotency-Key must be 1-255 printable ASCII characters");

    const ctx = this.#ctx;
    const tokenId = input.actor.tokenId;
    const hash = requestHash(input);
    const mismatch = () => new AppError("unprocessable", "this Idempotency-Key was already used with a different request");

    const seen = this.#keys.get(key, tokenId);
    if (seen && seen.createdAt > ctx.now() - IDEMPOTENCY_TTL_MS) {
      const preview = seen.previewId ? ctx.previews.get(seen.previewId) : undefined;
      if (preview && preview.state !== "destroyed" && preview.state !== "destroying") {
        if (seen.requestHash !== hash) throw mismatch();
        const done = ctx.inflight.get(preview.id)?.done ?? Promise.resolve(preview);
        return { preview, urls: urlsFor(ctx, preview.id), done, replayed: true };
      }
    }

    // Concurrent retries, before any row exists: planning is awaited and takes a while.
    const flightKey = `${tokenId}\n${key}`;
    const joined = this.#flight.has(flightKey);
    const result = await this.#flight.run(flightKey, async () => {
      const res = await deploy(ctx, input);
      this.#keys.put({ key, tokenId, previewId: res.preview.id, requestHash: hash });
      return res;
    });
    if (joined && this.#keys.get(key, tokenId)?.requestHash !== hash) throw mismatch();
    return { ...result, replayed: joined };
  }

  /** The scheduler's hourly job. */
  purge(): number {
    return this.#keys.purge(this.#ctx.now() - IDEMPOTENCY_TTL_MS);
  }
}
