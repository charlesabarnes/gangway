import { describe, expect, test } from "bun:test";
import type { Project } from "@gangway/shared/domain";
import { DEFAULT_SECRET_TARGETS, type SecretTargets } from "@gangway/shared/permissions";
import { credentialPermissions, tokenActor, type Actor } from "../../src/auth/actor.ts";
import { grantedTargets, secretRefusal } from "../../src/auth/secret-access.ts";
import { MissingPermission } from "../../src/mcp/tool-access.ts";
import { parseDotenv } from "../../src/mcp/secret-uploads.ts";
import { destroy } from "../../src/previews/destroy.ts";
import { fixedPolicy } from "../../src/previews/policy.ts";
import { setupTools } from "../helpers/mcp-tools.ts";
import { HOME_ORG_ID } from "../../src/db/repos/orgs.ts";

type Setup = ReturnType<typeof setupTools>;

const APP = {
  "package.json": JSON.stringify({ name: "app", scripts: { start: "node server.js" } }),
  "server.js": "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT)",
};

/** The compose file and .env `compose config` read, where every secret shows up. */
function stackAtConfig(s: Setup) {
  const seen = { text: "" };
  const inner = s.ctx.compose;
  s.ctx.compose = {
    ...inner,
    capture: async (argv, host, o) => {
      if (argv.includes("config")) {
        const dir = argv[argv.indexOf("--project-directory") + 1]!;
        const file = await Bun.file(argv[argv.indexOf("--file") + 1]!).text();
        const env = await Bun.file(`${dir}/.env`)
          .text()
          .catch(() => "");
        seen.text = `${file}\n${env}`;
      }
      return inner.capture(argv, host, o);
    },
  };
  return seen;
}

const agent = (targets: SecretTargets = DEFAULT_SECRET_TARGETS, id = "t-agent"): Actor => ({
  kind: "token",
  orgId: HOME_ORG_ID,
  tokenId: id,
  scopes: ["read", "deploy", "secrets"],
  permissions: credentialPermissions(["read", "deploy", "secrets"], targets),
  secretTargets: targets,
});

async function deployApp(s: Setup, actor: Actor, extra: Record<string, unknown> = {}) {
  const out = await s.tools.deploy(s.scope(actor), {
    files: APP,
    name: "app",
    title: "App",
    ...extra,
  });
  const p = s.ctx.previews.list({}).find((x) => x.state !== "destroyed")!;
  return { out, p };
}

describe("deploy-time secrets", () => {
  test("merge over org and project secrets, stored sealed on the preview, masked in logs", async () => {
    const s = setupTools();
    const seen = stackAtConfig(s);
    s.secrets.global().update(null, { set: { ORG_KEY: "org-value-1234", SHARED: "from-org" } });
    const { out, p } = await deployApp(s, agent(), {
      secrets: { API_KEY: "sk-live-abcdef123", SHARED: "from-deploy" },
    });
    expect(out).toStartWith("ready:");
    expect(seen.text).toContain("sk-live-abcdef123");
    expect(seen.text).toContain("org-value-1234");
    expect(seen.text).toContain("from-deploy");
    expect(seen.text).not.toContain("from-org");
    expect(
      s.secrets
        .preview(p.id)
        .list()
        .map((x) => x.name),
    ).toEqual(["API_KEY", "SHARED"]);
    expect(s.ctx.previews.envCiphertext(p.id)).not.toContain("sk-live");
    s.ctx.logs.append(p.id, "system", "the app printed sk-live-abcdef123 and org-value-1234");
    const tail = s.ctx.logs.tail(p.id).join("\n");
    expect(tail).not.toContain("sk-live-abcdef123");
    expect(tail).not.toContain("org-value-1234");
    expect(JSON.stringify(s.audit.page({ limit: 50 }).entries)).not.toContain("sk-live");
  });

  test("a preview's own secrets reach it even at clearance none; the org's do not", async () => {
    const s = setupTools();
    s.ctx.policy = fixedPolicy({ clearance: "none" });
    const seen = stackAtConfig(s);
    s.secrets.global().update(null, { set: { ORG_KEY: "org-value-1234" } });
    await deployApp(s, agent(), { secrets: { API_KEY: "sk-live-abcdef123" } });
    expect(seen.text).toContain("sk-live-abcdef123");
    expect(seen.text).not.toContain("org-value-1234");
  });

  test("a rebuild keeps them and applies what it sends; destroy wipes them", async () => {
    const s = setupTools();
    const seen = stackAtConfig(s);
    const { p } = await deployApp(s, agent(), { secrets: { API_KEY: "sk-live-abcdef123" } });
    seen.text = "";
    const out = await s.tools.deploy(s.scope(agent()), {
      preview: "app",
      secrets: { SECOND: "second-value-99" },
    });
    expect(out).toStartWith("ready:");
    expect(seen.text).toContain("sk-live-abcdef123");
    expect(seen.text).toContain("second-value-99");
    await s.tools.deploy(s.scope(agent()), { preview: "app", unsetSecrets: ["API_KEY"] });
    expect(
      s.secrets
        .preview(p.id)
        .list()
        .map((x) => x.name),
    ).toEqual(["SECOND"]);
    await destroy(s.ctx, p.id, agent());
    expect(s.ctx.previews.envCiphertext(p.id)).toBeNull();
  });

  test("a deploy-scope credential cannot send secrets", async () => {
    const s = setupTools();
    const deployOnly = tokenActor("t-deploy", ["read", "deploy"], HOME_ORG_ID);
    await expect(
      s.tools.deploy(s.scope(deployOnly), { files: APP, secrets: { A: "b" } }),
    ).rejects.toThrow(MissingPermission);
    expect(s.ctx.previews.list({})).toHaveLength(0);
  });
});

describe("the secrets tool", () => {
  test("sets on a preview it deployed, lists names only, never values", async () => {
    const s = setupTools();
    const me = agent();
    await deployApp(s, me);
    const out = s.tools.secrets(s.scope(me), {
      target: { preview: "app" },
      set: { API_KEY: "sk-live-abcdef123" },
    });
    expect(out).toMatch(/^1 secret at app-[a-z0-9]+:\n {2}API_KEY\n/);
    expect(out).toContain("takes effect on its next rebuild");
    expect(out).not.toContain("sk-live");
    const listed = s.tools.secrets(s.scope(me), { target: { preview: "app" } });
    expect(listed).toContain("API_KEY");
    expect(listed).toContain("Values are never shown.");
  });

  test("an own-previews credential may not touch another's preview, a project or the org", async () => {
    const s = setupTools();
    await deployApp(s, agent(DEFAULT_SECRET_TARGETS, "t-other"));
    s.projects.create({ id: "P1", name: "shop", slug: "shop" });
    const me = agent();
    expect(() => s.tools.secrets(s.scope(me), { target: { org: true }, set: { A: "b" } })).toThrow(
      "may not set org-wide secrets",
    );
    expect(() =>
      s.tools.secrets(s.scope(me), { target: { project: "shop" }, set: { A: "b" } }),
    ).toThrow('may not set secrets on project "shop"');
    expect(() =>
      s.tools.secrets(s.scope(me), { target: { preview: "app" }, set: { A: "b" } }),
    ).toThrow("only on previews it deployed");
  });

  test("an upload's values never come back; the names do; it works once", async () => {
    const s = setupTools();
    const me = agent();
    await deployApp(s, me);
    const issued = s.tools.secrets(s.scope(me), { target: { preview: "app" }, upload: "new" });
    const id = /upload: "([A-Za-z0-9_-]{43})"/.exec(issued)![1]!;
    expect(issued).toContain(`--data-binary @.env '`);
    const names = await s.secretUploads.receive(
      id,
      new Response('# comment\nexport API_KEY="sk-live-abcdef123"\nOTHER=plain # note\n').body,
    );
    expect(names).toEqual(["API_KEY", "OTHER"]);
    const out = s.tools.secrets(s.scope(me), { target: { preview: "app" }, upload: id });
    expect(out).toContain("API_KEY");
    expect(out).not.toContain("sk-live");
    expect(() => s.tools.secrets(s.scope(me), { target: { preview: "app" }, upload: id })).toThrow(
      "no such secret upload",
    );
  });
});

describe("secret targets", () => {
  const project = { id: "P1", slug: "shop" } as Project;
  const preview = (credential: string | null) => ({
    kind: "preview" as const,
    preview: {} as never,
    name: "app",
    provenance: { owner: credential, credential },
    project: null,
  });

  test("the defaults hold an agent to the previews it deployed", () => {
    const me = agent();
    expect(secretRefusal(me, preview("t-agent"))).toBeNull();
    expect(secretRefusal(me, preview("t-else"))).toContain("only on previews it deployed");
    expect(secretRefusal(me, { kind: "project", project })).not.toBeNull();
    expect(secretRefusal(me, { kind: "org" })).not.toBeNull();
  });

  test("wider targets add repos.secrets, and reach only what they name", () => {
    const some = agent({ previews: "own", projects: ["P1"], org: false });
    expect(some.permissions.has("repos.secrets")).toBe(true);
    expect(secretRefusal(some, { kind: "project", project })).toBeNull();
    expect(
      secretRefusal(some, { kind: "project", project: { id: "P2", slug: "b" } as Project }),
    ).not.toBeNull();
    expect(secretRefusal(some, { kind: "org" })).not.toBeNull();
    const all = agent({ previews: "all", projects: "all", org: true });
    expect(secretRefusal(all, { kind: "org" })).toBeNull();
    // "Any preview it may rebuild": someone else's needs the update scope as well.
    expect(secretRefusal(all, preview("t-else"))).not.toBeNull();
    const updater: Actor = {
      ...all,
      permissions: new Set([...all.permissions, "previews.update" as const]),
    };
    expect(secretRefusal(updater, preview("t-else"))).toBeNull();
  });

  test("minting checks the maker's role and needs the secrets scope", () => {
    const member = tokenActor("m", ["read", "deploy", "secrets"], HOME_ORG_ID);
    expect(grantedTargets(member, ["secrets"], undefined)).toEqual(DEFAULT_SECRET_TARGETS);
    expect(() =>
      grantedTargets(member, ["secrets"], { previews: "own", projects: [], org: true }),
    ).toThrow("your role does not cover project or org secrets");
    expect(() => grantedTargets(member, ["deploy"], DEFAULT_SECRET_TARGETS)).toThrow(
      "needs the secrets scope",
    );
    expect(grantedTargets(member, ["deploy"], undefined)).toBeNull();
  });
});

describe("parseDotenv", () => {
  test("reads what a .env holds", () => {
    expect(
      parseDotenv(
        [
          "# a comment",
          "",
          "export A=1",
          "B = two words # trailing",
          `C="line\\nbreak \\"quoted\\""`,
          "D='single $x'",
          'E="multi',
          'line"',
        ].join("\n"),
      ),
    ).toEqual({
      A: "1",
      B: "two words",
      C: 'line\nbreak "quoted"',
      D: "single $x",
      E: "multi\nline",
    });
    expect(() => parseDotenv("not a line")).toThrow("line 1 is not NAME=value");
    expect(() => parseDotenv("1BAD=x")).toThrow("not a valid environment variable name");
  });
});
