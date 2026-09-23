import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";
import { createCa, issueLeaf, loadOrCreateCa } from "../../src/tls/selfsigned.ts";
import { CertStore } from "../../src/tls/certstore.ts";
import { FileProvider, SelfSignedProvider, RENEWAL_WINDOW_MS } from "../../src/tls/provider.ts";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gangway-tls-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sans = (pem: string) => {
  const c = new x509.X509Certificate(
    pem.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----",
  );
  const ext = c.getExtension(x509.SubjectAlternativeNameExtension);
  return ext ? ext.names.items.map((n) => n.value) : [];
};

describe("dev CA", () => {
  test("issues a leaf chaining to the CA", async () => {
    const ca = await createCa();
    const leaf = await issueLeaf(ca, ["*.preview.test", "preview.test"]);

    // The leaf must ship the CA after it or clients fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
    expect(leaf.cert.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(leaf.cert).toContain(ca.certPem.trim());
    expect(leaf.key).toContain("BEGIN PRIVATE KEY");
    expect(leaf.serverName).toBe("*.preview.test");
  });

  test("the leaf covers BOTH the wildcard and the apex", async () => {
    // A wildcard does not match the apex, and the reserved labels need the apex form (§6.2).
    const ca = await createCa();
    const leaf = await issueLeaf(ca, ["*.preview.test", "preview.test"]);
    expect(sans(leaf.cert)).toEqual(["*.preview.test", "preview.test"]);
  });

  test("the CA is a CA and the leaf is not", async () => {
    const ca = await createCa();
    const leaf = await issueLeaf(ca, ["*.preview.test"]);
    const caCert = new x509.X509Certificate(ca.certPem);
    const leafCert = new x509.X509Certificate(
      leaf.cert.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----",
    );
    expect(caCert.getExtension(x509.BasicConstraintsExtension)?.ca).toBe(true);
    expect(leafCert.getExtension(x509.BasicConstraintsExtension)?.ca).toBe(false);
    expect(leafCert.issuer).toBe(caCert.subject);
  });

  test("the leaf verifies against the CA", async () => {
    const ca = await createCa();
    const leaf = await issueLeaf(ca, ["*.preview.test"]);
    const leafCert = new x509.X509Certificate(
      leaf.cert.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----",
    );
    expect(
      await leafCert.verify({ publicKey: new x509.X509Certificate(ca.certPem).publicKey }),
    ).toBe(true);
  });

  test("the CA persists across restarts so it is trusted once, not every boot", async () => {
    const dir = tmp();
    const a = await loadOrCreateCa(dir);
    const b = await loadOrCreateCa(dir);
    expect(a.ca.certPem).toBe(b.ca.certPem);
    expect(existsSync(a.caPath)).toBe(true);
    expect(readFileSync(a.caPath, "utf8")).toContain("BEGIN CERTIFICATE");
  });

  test("each leaf gets a distinct serial, so a swap is observable", async () => {
    const ca = await createCa();
    const a = await issueLeaf(ca, ["*.preview.test"]);
    await Bun.sleep(2);
    const b = await issueLeaf(ca, ["*.preview.test"]);
    expect(a.serialNumber).not.toBe(b.serialNumber);
  });
});

describe("SelfSignedProvider", () => {
  test("produces a bundle Bun.serve can consume", async () => {
    const p = new SelfSignedProvider(tmp());
    const bundle = await p.ensure(["*.preview.localhost", "preview.localhost"]);
    expect(bundle.materials).toHaveLength(1);
    // Bun REQUIRES serverName on every tls array entry or it throws ERR_INVALID_ARG_TYPE.
    expect(bundle.materials[0]!.serverName).toBe("*.preview.localhost");
    expect(bundle.caPath).toBeDefined();
  });

  test("renewal is due when expiry falls inside the window", async () => {
    const p = new SelfSignedProvider(tmp());
    const bundle = await p.ensure(["*.preview.localhost"]);
    expect(p.isDue(bundle)).toBe(false);
    const nearExpiry = bundle.materials[0]!.notAfter!.getTime() - RENEWAL_WINDOW_MS + 1000;
    expect(p.isDue(bundle, nearExpiry)).toBe(true);
    expect(p.isDue({ materials: [] })).toBe(true);
  });
});

describe("FileProvider", () => {
  test("loads material from disk and never auto-renews", async () => {
    const dir = tmp();
    const ca = await createCa();
    const leaf = await issueLeaf(ca, ["*.preview.test"]);
    await Bun.write(join(dir, "c.pem"), leaf.cert);
    await Bun.write(join(dir, "k.pem"), leaf.key);

    const p = new FileProvider(join(dir, "c.pem"), join(dir, "k.pem"));
    const bundle = await p.ensure(["*.preview.test"]);
    expect(bundle.materials[0]!.cert).toContain("BEGIN CERTIFICATE");
    expect(p.isDue()).toBe(false); // the operator owns the lifecycle
  });
});

describe("CertStore", () => {
  const mat = (serverName: string, notAfter?: Date) => ({
    serverName,
    cert: "C",
    key: "K",
    notAfter,
  });

  test("tlsConfig carries serverName on every entry", () => {
    const s = new CertStore({ materials: [mat("*.a.test"), mat("*.b.test")] });
    expect(s.tlsConfig()).toEqual([
      { serverName: "*.a.test", cert: "C", key: "K" },
      { serverName: "*.b.test", cert: "C", key: "K" },
    ]);
  });

  test("swap notifies listeners so the listener can rebind", async () => {
    const s = new CertStore({ materials: [mat("*.a.test")] });
    const seen: string[] = [];
    s.onSwap((b) => {
      seen.push(b.materials[0]!.serverName);
    });
    await s.swap({ materials: [mat("*.new.test")] });
    expect(seen).toEqual(["*.new.test"]);
    expect(s.current().materials[0]!.serverName).toBe("*.new.test");
  });

  test("unsubscribing stops notifications", async () => {
    const s = new CertStore({ materials: [mat("*.a.test")] });
    let n = 0;
    const off = s.onSwap(() => {
      n++;
    });
    await s.swap({ materials: [mat("*.b.test")] });
    off();
    await s.swap({ materials: [mat("*.c.test")] });
    expect(n).toBe(1);
  });

  test("refuses an empty bundle rather than serving no certificate", async () => {
    const s = new CertStore({ materials: [mat("*.a.test")] });
    await expect(s.swap({ materials: [] })).rejects.toThrow(/empty certificate bundle/);
    expect(s.current().materials).toHaveLength(1);
  });

  test("earliestNotAfter governs renewal across the bundle", () => {
    const soon = new Date(Date.now() + 1000);
    const later = new Date(Date.now() + 100_000);
    const s = new CertStore({ materials: [mat("*.a.test", later), mat("*.b.test", soon)] });
    expect(s.earliestNotAfter()).toEqual(soon);
    expect(new CertStore({ materials: [mat("*.a.test")] }).earliestNotAfter()).toBeNull();
  });
});
