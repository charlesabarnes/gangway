import { describe, expect, test } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { dispatch, type DispatchDeps } from "../../src/net/dispatch.ts";
import { DEFAULT_LIMITS } from "../../src/net/limits.ts";
import {
  forMark,
  MARK_PATH,
  markScript,
  stamp,
  underDomains,
  wantsMark,
  type MarkMode,
} from "../../src/net/watermark.ts";
import type { Actor } from "../../src/auth/actor.ts";
import type { RouteEntry } from "../../src/routing/table.ts";
import { previewPasswordApi } from "../helpers/preview-password.ts";

const TAG = `<script src="${MARK_PATH}" async data-gangway-mark></script>`;
const HOST = "shop.preview.example.com";

const page = (body: string | Uint8Array, headers: Record<string, string> = {}, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
const nav = (headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://${HOST}/`, {
    method,
    headers: { host: HOST, "sec-fetch-dest": "document", ...headers },
  });

describe("which requests get the mark", () => {
  test("a page load does; an asset, a fetch, a HEAD or a socket does not", () => {
    expect(wantsMark(nav())).toBe(true);
    expect(wantsMark(new Request(`https://${HOST}/`))).toBe(true);
    expect(wantsMark(nav({ "sec-fetch-dest": "script" }))).toBe(false);
    expect(wantsMark(nav({ "sec-fetch-dest": "iframe" }))).toBe(false);
    expect(wantsMark(nav({ "sec-fetch-dest": "empty" }))).toBe(false);
    expect(wantsMark(nav({}, "HEAD"))).toBe(false);
    expect(wantsMark(nav({ upgrade: "websocket", connection: "Upgrade" }))).toBe(false);
  });

  test("the request asks for the page uncompressed and drops an unmarked validator", () => {
    const r = forMark(nav({ "accept-encoding": "br, zstd, gzip", "if-none-match": '"abc"' }));
    expect(r.headers.get("accept-encoding")).toBe("identity");
    expect(r.headers.has("if-none-match")).toBe(false);
    const again = forMark(nav({ "if-none-match": 'W/"abc-gwm"' }));
    expect(again.headers.get("if-none-match")).toBe('W/"abc"');
  });
});

describe("stamping a page", () => {
  test("the tag goes before </body>, and the length and strong validator go", async () => {
    const res = stamp(
      page("<html><body><h1>Hi</h1></body></html>", { "content-length": "38", etag: '"abc"' }),
      nav(),
    );
    expect(await res.text()).toBe(`<html><body><h1>Hi</h1>${TAG}</body></html>`);
    expect(res.headers.has("content-length")).toBe(false);
    expect(res.headers.get("etag")).toBe('W/"abc-gwm"');
  });

  test("a page with no body element gets it at the end", async () => {
    expect(await stamp(page("<p>just a fragment"), nav()).text()).toBe(`<p>just a fragment${TAG}`);
  });

  test("a gzipped page is read, marked and compressed again for a client that takes gzip", async () => {
    const res = stamp(
      page(gzipSync("<body>x</body>"), { "content-encoding": "gzip" }),
      nav({ "accept-encoding": "gzip, br" }),
    );
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString();
    expect(text).toBe(`<body>x${TAG}</body>`);
  });

  test("the same gzipped page goes out plain to a client that does not take gzip", async () => {
    const res = stamp(page(gzipSync("<body>x</body>"), { "content-encoding": "gzip" }), nav());
    expect(res.headers.has("content-encoding")).toBe(false);
    expect(await res.text()).toBe(`<body>x${TAG}</body>`);
  });

  test("anything it cannot or should not change passes through untouched", async () => {
    const cases: Response[] = [
      new Response("{}", { headers: { "content-type": "application/json" } }),
      page("<body></body>", { "content-encoding": "br" }),
      page("<body></body>", { "cache-control": "no-transform" }),
      page("<body></body>", {}, 404),
      page("<body></body>", { "content-range": "bytes 0-5/10" }, 206),
    ];
    for (const res of cases) {
      expect(stamp(res, nav())).toBe(res);
    }
  });

  test("a 304 keeps the marked validator, so the cached marked page stays valid", () => {
    const res = stamp(new Response(null, { status: 304, headers: { etag: '"abc"' } }), nav());
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('W/"abc-gwm"');
  });
});

describe("the report link", () => {
  test("is there only with a report URL, and drops the query and hash", () => {
    expect(markScript("https://gangway.sh")).not.toContain('class=\\"report');
    const js = markScript("https://gangway.sh", "https://cloud.example.com/report");
    expect(js).toContain('class=\\"report');
    expect(js).toContain('aria-label=\\"Report this page');
    expect(js).toContain(
      '"https://cloud.example.com/report?url="+encodeURIComponent(location.origin+location.pathname)',
    );
    expect(js).not.toContain("location.href");
    expect(js).not.toContain("location.search");
    expect(markScript("", "https://x.example.com/r#form")).toContain(
      '"https://x.example.com/r?url="+encodeURIComponent(location.origin+location.pathname)+"#form"',
    );
    expect(markScript("", "https://x.example.com/r?src=mark")).toContain(
      '"https://x.example.com/r?src=mark&url="',
    );
  });

  test("a report-only chip has no branding", () => {
    const js = markScript("https://gangway.sh", "https://cloud.example.com/report", "report");
    expect(js).toContain('class=\\"chip only');
    expect(js).not.toContain("gangway</span>");
    expect(js).not.toContain('href=\\"https://gangway.sh');
  });

  test("domains match exactly or as a parent, never as a bare suffix", () => {
    const list = ["gway.app"];
    expect(underDomains("gway.app", list)).toBe(true);
    expect(underDomains("shop.acme.gway.app", list)).toBe(true);
    expect(underDomains("SHOP.Acme.GWAY.app.", list)).toBe(true);
    expect(underDomains("evilgway.app", list)).toBe(false);
    expect(underDomains("gway.app.evil.com", list)).toBe(false);
    expect(underDomains("shop.example.com", [])).toBe(false);
  });

  test("a report-mode page gets the report script tag and its own validator", async () => {
    const report = { mode: "report", version: "" } as const;
    const res = stamp(page("<body>x</body>", { etag: '"abc"' }), nav(), report);
    expect(await res.text()).toBe(
      `<body>x<script src="${MARK_PATH}?report" async data-gangway-mark></script></body>`,
    );
    expect(res.headers.get("etag")).toBe('W/"abc-gwr"');
    const again = forMark(nav({ "if-none-match": 'W/"abc-gwr"' }), report);
    expect(again.headers.get("if-none-match")).toBe('W/"abc"');
  });

  test("only the current stamp's validator goes upstream", () => {
    const mark = { mode: "mark", version: "v2" } as const;
    const stale = forMark(nav({ "if-none-match": 'W/"abc-gwr", W/"abc-gwmv1"' }), mark);
    expect(stale.headers.get("if-none-match")).toBeNull();
    const fresh = forMark(nav({ "if-none-match": 'W/"abc-gwmv2"' }), mark);
    expect(fresh.headers.get("if-none-match")).toBe('W/"abc"');
  });

  test("the script URL and validator carry the settings' version", async () => {
    const res = stamp(page("<body>x</body>", { etag: '"abc"' }), nav(), {
      mode: "report",
      version: "k3x",
    });
    expect(await res.text()).toContain(`src="${MARK_PATH}?v=k3x&report"`);
    expect(res.headers.get("etag")).toBe('W/"abc-gwrk3x"');
  });

  test("dispatch stamps by the mode it is given and answers the report script", async () => {
    const res = await dispatch(nav(), deps("report"));
    expect(await res.text()).toBe(
      `<body>app<script src="${MARK_PATH}?report" async data-gangway-mark></script></body>`,
    );
    const js = await dispatch(
      new Request(`https://${HOST}${MARK_PATH}?report`, { headers: { host: HOST } }),
      deps(false),
    );
    expect(await js.text()).toBe("/* report */");
  });
});

describe("the mark script", () => {
  test("skips frames, draws in a closed shadow root and links where the setting says", () => {
    const js = markScript("https://gangway.sh");
    expect(js).toContain("window.top!==window.self");
    expect(js).toContain('mode:"closed"');
    expect(js).toContain('href=\\"https://gangway.sh\\"');
    expect(markScript("")).not.toContain("href=");
  });
});

function entry(over: Partial<RouteEntry> = {}): RouteEntry {
  return {
    hostname: HOST,
    previewId: "p1",
    hostId: "local",
    project: "gw-1",
    service: "web",
    containerPort: 3000,
    upstreamHost: "127.0.0.1",
    upstreamPort: 31000,
    primary: true,
    visibility: "public",
    password: { mode: "inherit" },
    passwordLogin: "inherit",
    state: "awake",
    site: false,
    inflight: 0,
    bytesInFlight: 0,
    lastSeenAt: 0,
    ...over,
  };
}

function deps(on: boolean | MarkMode, seen: Request[] = []): DispatchDeps {
  const modes = { true: "mark", false: null } as const;
  const mode: MarkMode | null = typeof on === "boolean" ? modes[`${on}`] : on;
  const e = entry();
  return {
    baseDomain: () => "preview.example.com",
    table: {
      lookup: (h: string) => (h === HOST ? e : undefined),
    } as unknown as DispatchDeps["table"],
    upstream: {
      name: "stub",
      fetch: async (req) => {
        seen.push(req);
        return page("<body>app</body>");
      },
    },
    limits: DEFAULT_LIMITS,
    surfaceEnabled: () => true,
    handlers: {},
    clientIpFor: () => "10.0.0.1",
    watermark: { mode: () => mode, script: (m) => `/* ${m} */`, version: () => "" },
  };
}

describe("dispatch", () => {
  test("stamps a proxied page when the preview's mark is on", async () => {
    const seen: Request[] = [];
    const res = await dispatch(nav({ "accept-encoding": "br" }), deps(true, seen));
    expect(await res.text()).toBe(`<body>app${TAG}</body>`);
    expect(seen[0]!.headers.get("accept-encoding")).toBe("identity");
  });

  test("leaves the page alone when it is off", async () => {
    const seen: Request[] = [];
    const res = await dispatch(nav({ "accept-encoding": "br" }), deps(false, seen));
    expect(await res.text()).toBe("<body>app</body>");
    expect(seen[0]!.headers.get("accept-encoding")).toBe("br");
  });

  test("answers the script itself, whatever the preview's mark", async () => {
    const res = await dispatch(
      new Request(`https://${HOST}${MARK_PATH}`, { headers: { host: HOST } }),
      deps(false),
    );
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toBe("/* mark */");
  });
});

describe("whose choice wins", () => {
  test("the preview's own, then its repository's, else null for the setting", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    expect(t.previews.watermarkOf(p.id)).toBeNull();
    t.db.run(
      "INSERT INTO projects (id, name, slug, created_at, updated_at, watermark) VALUES ('r1', 'web', 'web', 1, 1, 'off')",
    );
    t.db.run("UPDATE previews SET project_id = 'r1' WHERE id = $id", { id: p.id });
    expect(t.previews.watermarkOf(p.id)).toBe(false);
    t.previews.setWatermark(p.id, "on");
    expect(t.previews.watermarkOf(p.id)).toBe(true);
    t.previews.setWatermark(p.id, "inherit");
    expect(t.previews.watermarkOf(p.id)).toBe(false);
  });
});

describe("PUT /v1/previews/:id/watermark", () => {
  test("switches it with no rebuild, and is audited", async () => {
    const t = previewPasswordApi();
    const p = await t.deployed("live");
    const res = await t.putWatermark(p.id, { watermark: "off" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { preview: { watermark: string } }).preview.watermark).toBe(
      "off",
    );
    const audit = t.db.query("SELECT new_json FROM audit WHERE action = 'preview.watermark'") as {
      new_json: string;
    }[];
    expect(audit.map((a) => JSON.parse(a.new_json))).toEqual(["off"]);
  });

  test("needs previews.watermark as well as the right to change the preview", async () => {
    const member: Actor = {
      kind: "user",
      userId: "u-ada",
      roleId: "member",
      permissions: new Set(["previews.update"]),
      sessionId: "s",
    };
    const t = previewPasswordApi(member);
    const p = await t.deployed("live");
    expect((await t.putWatermark(p.id, { watermark: "off" })).status).toBe(403);
    expect(t.previews.get(p.id)!.watermark).toBe("inherit");
  });
});
