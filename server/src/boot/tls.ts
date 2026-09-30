import type { Logger } from "../logger.ts";
import { SETTINGS, type Settings } from "../settings.ts";
import { AcmeProvider, type AcmeConnect } from "../tls/acme.ts";
import { CloudflareDnsProvider } from "../tls/dns/cloudflare.ts";
import { ManualDnsProvider } from "../tls/dns/manual.ts";
import type { DnsProvider } from "../tls/dns/provider.ts";
import { CertManager } from "../tls/certs.ts";
import { FileProvider } from "../tls/provider.ts";
import { loadOrCreateCa, type DevCa } from "../tls/selfsigned.ts";
import type { CertBundle } from "../tls/types.ts";
import type { Core } from "./core.ts";

export type AcmeOverrides = { dns?: DnsProvider; connect?: AcmeConnect };

type TlsDeps = Core & { acmeOverrides: AcmeOverrides | undefined };

export type Certificates = {
  bundle: CertBundle;
  caPath: string | null;
  /** Keeps a certificate per domain current; null when a file holds the one certificate. */
  manager: CertManager | null;
};

export async function resolveCertificates(
  core: Core,
  acmeOverrides: AcmeOverrides | undefined,
): Promise<Certificates> {
  const d: TlsDeps = { ...core, acmeOverrides };
  const { config } = d;
  switch (config.tlsMode) {
    case "file": {
      if (!config.tlsCertPath || !config.tlsKeyPath) {
        throw new Error("tlsMode=file needs GANGWAY_TLS_CERT_PATH and GANGWAY_TLS_KEY_PATH");
      }
      const names = core.domains.certUnits().flatMap((u) => u.names);
      const bundle = await new FileProvider(config.tlsCertPath, config.tlsKeyPath).ensure(names);
      return { bundle, caPath: null, manager: null };
    }
    case "acme":
      return acmeCertificates(d);
    default: {
      const { caPath, devCa } = devCaOf(d);
      const manager = new CertManager({
        mode: "selfsigned",
        plan: () => core.domains.certUnits(),
        devCa,
        logger: d.logger.child({ mod: "tls" }),
      });
      return { bundle: await manager.start(), caPath: await caPath(), manager };
    }
  }
}

async function acmeCertificates(d: TlsDeps): Promise<Certificates> {
  const tlsLog = d.logger.child({ mod: "tls" });
  const acme = new AcmeProvider({
    directoryUrl: d.settings.get(SETTINGS.acmeDirectoryUrl),
    email: d.settings.get(SETTINGS.acmeEmail),
    dns: d.acmeOverrides?.dns ?? dnsProvider(d.settings, tlsLog),
    certs: d.repos.certificates,
    store: d.repos.settings,
    logger: tlsLog,
    ...(d.acmeOverrides?.connect ? { connect: d.acmeOverrides.connect } : {}),
  });
  const { caPath, devCa } = devCaOf(d);
  // Stored certificates serve at once; the dev CA stands in for the rest until cert-renew runs.
  const manager = new CertManager({
    mode: "acme",
    plan: () => d.domains.certUnits(),
    devCa,
    acme,
    logger: tlsLog,
  });
  const bundle = await manager.start();
  const waiting = manager.status().some((s) => !s.issued);
  return { bundle, caPath: waiting ? await caPath() : null, manager };
}

function devCaOf(d: TlsDeps): { devCa: () => Promise<DevCa>; caPath: () => Promise<string> } {
  let loaded: ReturnType<typeof loadOrCreateCa> | null = null;
  const load = () => (loaded ??= loadOrCreateCa(d.stateDir));
  return { devCa: async () => (await load()).ca, caPath: async () => (await load()).caPath };
}

function dnsProvider(settings: Settings, log: Logger): DnsProvider {
  const token = settings.get(SETTINGS.cloudflareApiToken);
  const zoneId = settings.get(SETTINGS.cloudflareZoneId);
  return token
    ? new CloudflareDnsProvider({ apiToken: token, ...(zoneId ? { zoneId } : {}), log })
    : new ManualDnsProvider({ log });
}
