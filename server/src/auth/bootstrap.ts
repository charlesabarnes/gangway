/**
 * First-run bootstrap: the server prints a one-time admin setup URL to stdout. There are
 * no default credentials.
 *
 * The secret lives in memory only and is regenerated on every boot while there are no
 * users. gangway runs in a container, so stdout is `docker logs`: a URL left there must be
 * dead the moment it has been used, and dead after the next restart if it never was. A
 * hashed row in the database would stay valid for as long as nobody finished setup.
 *
 * There is no "consumed" flag to get out of step. Setup is pending exactly while the
 * users table is empty; creating the first admin is what closes it, and that insert is
 * transactional (`Accounts.setupFirstAdmin`), so two racing requests make one admin.
 *
 * The `gw_` prefix is deliberate: the logger redacts anything shaped like that, so the
 * URL cannot reach a log line by accident. It is printed through `announce` instead.
 */
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

  /** `appOrigin` is the `app` surface's public origin -- the session cookie is host-only there. */
  url(appOrigin: string): string | null {
    return this.pending ? `${appOrigin}/setup?token=${this.#secret}` : null;
  }

  check(presented: string): boolean {
    if (!this.pending) return false;
    return timingSafeEqual(sha256(presented), sha256(this.#secret!));
  }
}
