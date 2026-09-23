/**
 * Secrets at rest (ADR-0012): AES-256-GCM under a key that lives in the STATE DIRECTORY
 * (`secrets.key`, 0600), not in the database -- so a copy of `gangway.db` alone, which is
 * what a backup is, reveals nothing. Lose the key and the secrets are gone; they were
 * never readable back anyway, so they are re-entered.
 *
 * Wire form: `v1.<iv>.<tag>.<ciphertext>`, base64url. Small, self-describing, versioned.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../errors.ts";

const ALG = "aes-256-gcm";

export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("a SecretBox key is 32 bytes");
    this.#key = key;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, this.#key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ct.toString("base64url"),
    ].join(".");
  }

  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !ct)
      throw new AppError("internal", "sealed secret has an unknown format");
    try {
      const d = createDecipheriv(ALG, this.#key, Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    } catch {
      throw new AppError("internal", "sealed secret could not be opened (wrong key, or tampered)");
    }
  }
}

/** The key file, made on first use. Owner-readable only. */
export function loadOrCreateSecretsKey(stateDir: string): Buffer {
  const file = join(stateDir, "secrets.key");
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    if (key.length === 32) return key;
    throw new Error(`${file} is not a 32-byte hex key`);
  }
  mkdirSync(stateDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex") + "\n", { mode: 0o600 });
  return key;
}
