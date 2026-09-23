import type { Logger } from "../logger.ts";
import type { SurfaceHandler } from "../net/dispatch.ts";
import type { Forge } from "./forge.ts";
import type { Outcome, PrPreviews } from "./pr-previews.ts";
import { errorMessage } from "../errors.ts";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const REMEMBERED_DELIVERIES = 2048;

export type HooksDeps = {
  forge: Forge;
  service: PrPreviews;
  logger: Logger;
  maxBodyBytes?: number | undefined;
  onOutcome?: ((deliveryId: string, outcome: Outcome) => void) | undefined;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export class Hooks {
  readonly #d: HooksDeps;
  readonly #seen = new Set<string>();
  readonly #inflight = new Set<Promise<void>>();

  constructor(d: HooksDeps) {
    this.#d = d;
  }

  get inflight(): number {
    return this.#inflight.size;
  }
  drain(): Promise<void> {
    return Promise.allSettled(this.#inflight).then(() => undefined);
  }

  handler(): SurfaceHandler {
    return async (req, ctx) => {
      const path = new URL(req.url).pathname;
      if (path !== `/${this.#d.forge.id}`) return json(404, { title: "not found", status: 404 });
      if (req.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "POST" } });

      const max = this.#d.maxBodyBytes ?? MAX_WEBHOOK_BYTES;
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > max) return json(413, { title: "payload too large", status: 413 });
      const raw = new Uint8Array(await req.arrayBuffer());
      if (raw.byteLength > max) return json(413, { title: "payload too large", status: 413 });

      const verdict = this.#d.forge.verify(req.headers, raw);
      if (!verdict.ok) {
        this.#d.logger.warn("webhook refused", {
          forge: this.#d.forge.id,
          reason: verdict.reason,
          clientIp: ctx.clientIp,
        });
        return json(401, { title: "unauthorized", status: 401, detail: verdict.reason });
      }
      const { deliveryId } = verdict;
      if (this.#seen.has(deliveryId))
        return json(202, { accepted: false, deliveryId, reason: "already delivered" });
      this.#remember(deliveryId);

      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return json(400, { title: "bad request", status: 400, detail: "the body is not JSON" });
      }
      const event = this.#d.forge.parse(req.headers, payload);
      if (event.type === "ignored") {
        this.#d.logger.debug("webhook ignored", { deliveryId, reason: event.reason });
        this.#d.onOutcome?.(deliveryId, { action: "ignored", reason: event.reason });
        return json(202, { accepted: false, deliveryId, reason: event.reason });
      }

      // Answer now: GitHub times out after 10s and a build takes minutes.
      const work = this.#d.service
        .handle(event)
        .then(
          (outcome) => {
            const { settled: _settled, ...shown } = outcome as Outcome & { settled?: unknown };
            this.#d.logger.info("webhook handled", { deliveryId, event: event.type, ...shown });
            this.#d.onOutcome?.(deliveryId, outcome);
          },
          (e) => {
            this.#d.logger.error("webhook failed", { deliveryId, event: event.type, err: e });
            this.#d.onOutcome?.(deliveryId, {
              action: "ignored",
              reason: `failed: ${errorMessage(e)}`,
            });
          },
        )
        .finally(() => {
          this.#inflight.delete(work);
        });
      this.#inflight.add(work);
      return json(202, { accepted: true, deliveryId, event: event.type });
    };
  }

  #remember(id: string): void {
    this.#seen.add(id);
    if (this.#seen.size > REMEMBERED_DELIVERIES) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
  }
}
