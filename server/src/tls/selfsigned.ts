/**
 * A local development CA and wildcard leaf, generated in-process.
 *
 * @peculiar/x509 over WebCrypto: pure JS, no native addon, and it works inside the
 * shipped container -- which the `openssl` CLI does not. Note `node:crypto` cannot issue
 * certificates at all (X509Certificate is parse-only), so a hand-rolled CA is not an
 * option without an ASN.1 encoder.
 *
 * A real CA -> leaf chain rather than a bare self-signed cert, because then the operator
 * trusts one certificate once and every future wildcard is trusted automatically.
 */
import "reflect-metadata"; // @peculiar/x509 pulls in tsyringe, which throws on load without it
import * as x509 from "@peculiar/x509";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CertMaterial } from "./types.ts";

x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

function pem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(der).toString("base64");
  return `-----BEGIN ${label}-----\n${(b64.match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;
}

async function exportKey(k: CryptoKey): Promise<string> {
  return pem(await crypto.subtle.exportKey("pkcs8", k), "PRIVATE KEY");
}

async function importKey(p: string): Promise<CryptoKey> {
  const b64 = p.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return crypto.subtle.importKey("pkcs8", Buffer.from(b64, "base64"), ALG, true, ["sign"]);
}

export type DevCa = { certPem: string; keyPem: string };

export async function createCa(commonName = "gangway development CA"): Promise<DevCa> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${commonName}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 10 * 365 * 86_400_000),
    signingAlgorithm: SIGN,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  return { certPem: cert.toString("pem"), keyPem: await exportKey(keys.privateKey) };
}

/** Issues a leaf for `sans`, signed by the CA. sans[0] becomes the SNI serverName. */
export async function issueLeaf(ca: DevCa, sans: string[], days = 397): Promise<CertMaterial> {
  const caCert = new x509.X509Certificate(ca.certPem);
  const caKey = await importKey(ca.keyPem);
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const serialNumber = Date.now().toString(16).padStart(16, "0");

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber,
    subject: `CN=${sans[0]}`,
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + days * 86_400_000),
    signingAlgorithm: SIGN,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"], false), // serverAuth
      new x509.SubjectAlternativeNameExtension(
        sans.map((v) => ({ type: "dns" as const, value: v })),
      ),
    ],
  });

  // Normalise: @peculiar/x509's PEM has no trailing newline, so a naive concat yields
  // "-----END CERTIFICATE----------BEGIN CERTIFICATE-----" and OpenSSL rejects the chain
  // with BAD_END_LINE.
  const chain = [cert.toString("pem"), ca.certPem].map((p) => p.trimEnd() + "\n").join("");

  return {
    serverName: sans[0]!,
    // The leaf must carry the CA after it, or clients get UNABLE_TO_VERIFY_LEAF_SIGNATURE.
    cert: chain,
    key: await exportKey(keys.privateKey),
    ca: ca.certPem,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    issuer: caCert.subject,
    serialNumber,
  };
}

/** Loads the CA from the state dir, creating it on first run. Stable across restarts so
 *  the operator trusts it once. */
export async function loadOrCreateCa(stateDir: string): Promise<{ ca: DevCa; caPath: string }> {
  const dir = join(stateDir, "dev-ca");
  const certPath = join(dir, "ca.pem");
  const keyPath = join(dir, "ca-key.pem");
  if (existsSync(certPath) && existsSync(keyPath)) {
    return {
      ca: { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") },
      caPath: certPath,
    };
  }
  mkdirSync(dir, { recursive: true });
  const ca = await createCa();
  writeFileSync(certPath, ca.certPem);
  writeFileSync(keyPath, ca.keyPem, { mode: 0o600 });
  return { ca, caPath: certPath };
}
