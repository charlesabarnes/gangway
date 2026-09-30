import { createHash } from "node:crypto";

export function sha256(data: string | Uint8Array): Buffer;
export function sha256(data: string | Uint8Array, encoding: BufferEncoding): string;
export function sha256(data: string | Uint8Array, encoding?: BufferEncoding): Buffer | string {
  const h = createHash("sha256").update(data);
  return encoding ? h.digest(encoding) : h.digest();
}
