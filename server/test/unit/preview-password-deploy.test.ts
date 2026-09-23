import { describe, expect, test } from "bun:test";
import { deploy } from "../../src/previews/deploy.ts";
import type { DeployInput } from "../../src/previews/deploy-types.ts";
import { setPreviewPassword } from "../../src/previews/password.ts";
import { ACTOR, setupPreviewContext } from "../helpers/preview-context.ts";
import { passwords, withPasswords } from "../helpers/preview-password.ts";

const deployNamed = async (
  t: ReturnType<typeof withPasswords>,
  name: string,
  over: Partial<DeployInput> = {},
) => {
  const res = await deploy(t.ctx, {
    actor: ACTOR,
    name,
    visibility: "public",
    source: t.image,
    ...over,
  });
  await res.done;
  return res.preview;
};

describe("deploying with a password", () => {
  test("omitted: inherit, and the route entry says so", async () => {
    const t = withPasswords();
    const preview = await deployNamed(t, "plain");
    expect(preview.password).toBe("inherit");
    expect(t.table.forPreview(preview.id)[0]!.password).toEqual({ mode: "inherit" });
  });

  test("set: hashed, never stored or logged as text", async () => {
    const t = withPasswords();
    const preview = await deployNamed(t, "set", {
      password: { mode: "set", value: "my own password" },
    });
    expect(preview.password).toBe("set");
    const stored = t.previews.passwordOf(preview.id);
    expect(stored.mode).toBe("set");
    expect(await passwords.verify("my own password", stored.secret!)).toBe(true);
    expect(t.table.forPreview(preview.id)[0]!.password).toMatchObject({
      mode: "own",
      hash: stored.secret!.hash,
    });
    expect(t.ctx.logs.tail(preview.id, 500).join("\n")).not.toContain("my own password");
    const dump = JSON.stringify(t.db.query("SELECT * FROM audit"));
    expect(dump).not.toContain("my own password");
  });

  test("generate: logged once, and verifies against the stored hash", async () => {
    const t = withPasswords();
    const preview = await deployNamed(t, "gen", { password: { mode: "generate" } });
    expect(preview.password).toBe("generated");
    const lines = t.ctx.logs.tail(preview.id, 500).filter((l) => l.includes("preview password"));
    expect(lines).toHaveLength(1);
    const plain = /: ([a-z0-9-]{19})$/.exec(lines[0]!)![1]!;
    expect(await passwords.verify(plain, t.previews.passwordOf(preview.id).secret!)).toBe(true);
    expect(JSON.stringify(t.db.query("SELECT * FROM previews"))).not.toContain(plain);
    expect(JSON.stringify(t.db.query("SELECT * FROM events"))).not.toContain(plain);
  });

  test("inherit while the default is `generated` gives the new preview its own", async () => {
    const t = withPasswords("generated");
    const preview = await deployNamed(t, "auto");
    expect(preview.password).toBe("generated");
    expect(
      t.ctx.logs.tail(preview.id, 500).some((l) => l.includes("preview password (generated")),
    ).toBe(true);
  });

  test("none opens it whatever the default", async () => {
    const t = withPasswords("generated");
    const preview = await deployNamed(t, "open", { password: { mode: "none" } });
    expect(preview.password).toBe("none");
    expect(t.table.forPreview(preview.id)[0]!.password).toEqual({ mode: "none" });
  });

  test("without a hasher, only inherit and none work", async () => {
    const t = setupPreviewContext();
    await expect(
      deploy(t.ctx, {
        actor: ACTOR,
        name: "x",
        visibility: "public",
        source: { kind: "image", image: "a", port: 80 },
        password: { mode: "generate" },
      }),
    ).rejects.toThrow(/not available/);
  });
});

describe("passwordLogin only, as stored", () => {
  test("its own column: switching away and back keeps the password and the earlier rule", async () => {
    const t = withPasswords();
    const preview = await deployNamed(t, "only", {
      password: { mode: "set", value: "pw" },
      passwordLogin: "only",
    });
    expect(preview.passwordLogin).toBe("only");
    expect(t.table.forPreview(preview.id)[0]!.passwordLogin).toBe("only");
    t.previews.setPasswordLogin(preview.id, "on");
    expect(t.previews.get(preview.id)!.passwordLogin).toBe("on");
    t.previews.setPasswordLogin(preview.id, "only");
    t.previews.setPasswordLogin(preview.id, "off");
    expect(t.previews.get(preview.id)!.passwordLogin).toBe("off");
    expect(t.previews.passwordOf(preview.id).mode).toBe("set");
  });

  test("refused with the web UI off: there would be no login page", async () => {
    const t = withPasswords();
    t.ctx.privateAvailable = () => false;
    const p = await t.deployed("x");
    await expect(
      setPreviewPassword(t.ctx, { actor: ACTOR, previewId: p.id, login: "only" }),
    ).rejects.toThrow(/web UI/);
  });
});
