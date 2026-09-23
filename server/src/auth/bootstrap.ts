import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256 } from "../util/hash.ts";

export class Bootstrap {
  readonly #userCount: () => number;
  readonly #secret: string | null;

  constructor(userCount: () => number) {
    this.#userCount = userCount;
    this.#secret = userCount() === 0 ? `gw_setup_${randomBytes(32).toString("base64url")}` : null;
  }

  get pending(): boolean {
    return this.#secret !== null && this.#userCount() === 0;
  }

  // The secret keeps the gw_ prefix so the logger redacts it; it is printed only through announce.
  url(appOrigin: string): string | null {
    return this.pending ? `${appOrigin}/setup?token=${this.#secret}` : null;
  }

  check(presented: string): boolean {
    if (!this.pending) return false;
    return timingSafeEqual(sha256(presented), sha256(this.#secret!));
  }
}
