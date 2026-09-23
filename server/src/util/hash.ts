import { createHash, type BinaryToTextEncoding } from "node:crypto";

export function sha256(data: string | Uint8Array): Buffer;
export function sha256(data: string | Uint8Array, encoding: BinaryToTextEncoding): string;
export function sha256(
  data: string | Uint8Array,
  encoding?: BinaryToTextEncoding,
): Buffer | string {
  const h = createHash("sha256").update(data);
  return encoding ? h.digest(encoding) : h.digest();
}
