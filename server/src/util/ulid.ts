const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[now % 32]! + out;
    now = Math.floor(now / 32);
  }
  return out;
}

function randomChars(): number[] {
  const bytes = new Uint8Array(RAND_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b % 32);
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    for (let i = RAND_LEN - 1; i >= 0; i--) {
      if (lastRandom[i]! < 31) {
        lastRandom[i]!++;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((n) => ENCODING[n]!).join("");
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isUlid = (s: string): boolean => ULID_RE.test(s);
