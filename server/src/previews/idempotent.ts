import { createHash } from "node:crypto";
import { actorId } from "../auth/actor.ts";
import type { IdempotencyRepo } from "../db/repos/idempotency.ts";
import { AppError, badRequest } from "../errors.ts";
import { SingleFlight } from "../util/async.ts";
import type { PreviewContext } from "./context.ts";
import { deploy, urlsFor } from "./deploy.ts";
import type { DeployInput, DeployResult } from "./deploy-types.ts";

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

const KEY_RE = /^[\x21-\x7e]{1,255}$/;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const requestHash = ({ actor: _actor, ...request }: DeployInput): string => {
  const source =
    request.source.kind === "tarball" ? { ...request.source, archive: undefined } : request.source;
  return createHash("sha256")
    .update(canonical({ ...request, source }))
    .digest("hex");
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
    if (!KEY_RE.test(key))
      throw badRequest("Idempotency-Key must be 1-255 printable ASCII characters");

    const ctx = this.#ctx;
    const ownerId = actorId(input.actor);
    const hash = requestHash(input);
    const mismatch = () =>
      new AppError(
        "unprocessable",
        "this Idempotency-Key was already used with a different request",
      );

    const seen = this.#keys.get(key, ownerId);
    if (seen && seen.createdAt > ctx.now() - IDEMPOTENCY_TTL_MS) {
      const preview = seen.previewId ? ctx.previews.get(seen.previewId) : undefined;
      if (preview && preview.state !== "destroyed" && preview.state !== "destroying") {
        if (seen.requestHash !== hash) throw mismatch();
        const done = ctx.inflight.get(preview.id)?.done ?? Promise.resolve(preview);
        return { preview, urls: urlsFor(ctx, preview.id), done, replayed: true };
      }
    }

    const flightKey = `${ownerId}\n${key}`;
    const joined = this.#flight.has(flightKey);
    const result = await this.#flight.run(flightKey, async () => {
      const res = await deploy(ctx, input);
      this.#keys.put({ key, ownerId, previewId: res.preview.id, requestHash: hash });
      return res;
    });
    if (joined && this.#keys.get(key, ownerId)?.requestHash !== hash) throw mismatch();
    return { ...result, replayed: joined };
  }

  purge(): number {
    return this.#keys.purge(this.#ctx.now() - IDEMPOTENCY_TTL_MS);
  }
}
