import type { Logger } from "../logger.ts";
import { SETTINGS, type Settings } from "../settings.ts";
import { AcmeProvider, type AcmeConnect } from "../tls/acme.ts";
import { CloudflareDnsProvider } from "../tls/dns/cloudflare.ts";
import { ManualDnsProvider } from "../tls/dns/manual.ts";
import type { DnsProvider } from "../tls/dns/provider.ts";
import { FileProvider, SelfSignedProvider } from "../tls/provider.ts";
import type { CertBundle } from "../tls/types.ts";
import type { Core } from "./core.ts";

export type AcmeOverrides = { dns?: DnsProvider; connect?: AcmeConnect };

type TlsDeps = Core & { domains: string[]; acmeOverrides: AcmeOverrides | undefined };

export type Certificates = {
  bundle: CertBundle;
  caPath: string | null;
  acme: AcmeProvider | null;
};

export async function resolveCertificates(
  core: Core,
  domains: string[],
  acmeOverrides: AcmeOverrides | undefined,
): Promise<Certificates> {
  const d: TlsDeps = { ...core, domains, acmeOverrides };
  const { config } = d;
  switch (config.tlsMode) {
    case "file": {
      if (!config.tlsCertPath || !config.tlsKeyPath)
        throw new Error("tlsMode=file needs GANGWAY_TLS_CERT_PATH and GANGWAY_TLS_KEY_PATH");
      const bundle = await new FileProvider(config.tlsCertPath, config.tlsKeyPath).ensure(domains);
      return { bundle, caPath: null, acme: null };
    }
    case "acme":
      return acmeCertificates(d);
    default:
      return { ...(await devCa(d)), acme: null };
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
  // With nothing stored, the dev CA serves until cert-renew swaps in the first real one.
  const stored = acme.load(d.domains);
  if (stored) return { bundle: stored, caPath: null, acme };
  tlsLog.warn(
    "no usable ACME certificate stored yet; serving the dev CA until the first order completes",
    { domains: d.domains },
  );
  return { ...(await devCa(d)), acme };
}

function dnsProvider(settings: Settings, log: Logger): DnsProvider {
  const token = settings.get(SETTINGS.cloudflareApiToken);
  const zoneId = settings.get(SETTINGS.cloudflareZoneId);
  return token
    ? new CloudflareDnsProvider({ apiToken: token, ...(zoneId ? { zoneId } : {}), log })
    : new ManualDnsProvider({ log });
}

async function devCa(d: TlsDeps): Promise<{ bundle: CertBundle; caPath: string | null }> {
  const bundle = await new SelfSignedProvider(d.stateDir).ensure(d.domains);
  return { bundle, caPath: bundle.caPath ?? null };
}
