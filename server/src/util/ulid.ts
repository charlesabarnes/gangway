import { must } from "@gangway/shared/must";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = "";
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomChars(): number[] {
  const bytes = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b % 32);
}

function increment(digits: number[]): void {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = must(digits[i], "a base32 digit");
    if (d < 31) {
      digits[i] = d + 1;
      return;
    }
    digits[i] = 0;
  }
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    increment(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((n) => ENCODING.charAt(n)).join("");
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isUlid = (s: string): boolean => ULID_RE.test(s);
