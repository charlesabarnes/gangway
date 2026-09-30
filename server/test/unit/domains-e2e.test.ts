/** A real boot with a second preview domain: its own certificate by SNI, and a preview under it. */
import { expect, test } from "bun:test";
import tls from "node:tls";
import { bootE2e, deployPreview } from "../helpers/boot-e2e.ts";

const certFor = (port: number, servername?: string) =>
  new Promise<string[]>((resolve, reject) => {
    const s = tls.connect(
      // codeql[js/disabling-certificate-validation] The test reads which certificate a local listener presents.
      { host: "127.0.0.1", port, servername, rejectUnauthorized: false },
      () => {
        const san = s.getPeerCertificate().subjectaltname ?? "";
        s.end();
        resolve(san.split(", ").map((n) => n.replace(/^DNS:/, "")));
      },
    );
    s.on("error", reject);
  });

test("each domain has its own certificate; a preview lands on its choice", async () => {
  const { running, call } = await bootE2e({ GANGWAY_PREVIEW_DOMAINS: "alt.localhost" });
  const port = running.listener.port;

  expect(await certFor(port, "app.preview.localhost")).toEqual([
    "*.preview.localhost",
    "preview.localhost",
  ]);
  expect(await certFor(port, "shop.alt.localhost")).toEqual(["*.alt.localhost", "alt.localhost"]);
  expect(await certFor(port, "alt.localhost")).toEqual(["*.alt.localhost", "alt.localhost"]);
  // No SNI, or a name gangway has no certificate for: the control domain's.
  expect(await certFor(port)).toEqual(["*.preview.localhost", "preview.localhost"]);

  const res = await deployPreview(running, { name: "shop", domain: "alt.localhost" });
  expect(res.status).toBe(201);
  const { preview } = (await res.json()) as { preview: { urls: { url: string }[] } };
  expect(preview.urls[0]!.url).toBe(`https://shop.alt.localhost:${port}/`);
  expect((await call("shop.alt.localhost", "/")).status).toBe(200);
  expect((await call("shop.preview.localhost", "/")).status).toBe(404);
});
