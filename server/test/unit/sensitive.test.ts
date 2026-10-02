import { describe, expect, test } from "bun:test";
import { sensitiveName } from "../../src/previews/sensitive.ts";

describe("files that may hold secrets", () => {
  test.each([
    ".env",
    ".env.local",
    ".env.production",
    "server.pem",
    "tls.KEY",
    "cert.p12",
    "id_rsa",
    "id_ed25519.pub",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".htpasswd",
    ".DS_Store",
  ])("%s is withheld", (name) => {
    expect(sensitiveName(name, false)).toBe(true);
  });

  test.each([
    "index.html",
    ".env.example",
    ".env.sample",
    ".env.template",
    ".gitignore",
    "environment.ts",
    "keys.json",
    "id_card.png",
  ])("%s is published", (name) => {
    expect(sensitiveName(name, false)).toBe(false);
  });

  test("whole directories of credentials, by name only as directories", () => {
    for (const dir of [".aws", ".ssh", ".gnupg", ".svn", ".hg"]) {
      expect(sensitiveName(dir, true)).toBe(true);
    }
    expect(sensitiveName(".well-known", true)).toBe(false);
    expect(sensitiveName(".github", true)).toBe(false);
    expect(sensitiveName(".env", true)).toBe(false);
  });
});
