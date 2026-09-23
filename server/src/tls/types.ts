export type CertMaterial = {
  // Bun requires serverName on every entry of a tls array.
  serverName: string;
  cert: string;
  key: string;
  ca?: string | undefined;
  notBefore?: Date | undefined;
  notAfter?: Date | undefined;
  issuer?: string | undefined;
  serialNumber?: string | undefined;
};

export type CertBundle = {
  materials: CertMaterial[];
  caPath?: string | undefined;
};

export interface CertProvider {
  readonly name: "selfsigned" | "file" | "acme";
  ensure(domains: string[]): Promise<CertBundle>;
  isDue(bundle: CertBundle, now?: number): boolean;
}
