/** Certificate material as Bun.serve's `tls` option consumes it. */
export type CertMaterial = {
  /** SNI name this entry answers for, e.g. "*.preview.example.com". Bun requires it on
   *  every entry of a tls array -- omitting it throws ERR_INVALID_ARG_TYPE. */
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
  /** Filesystem path of the dev CA to trust, when the provider generated one. */
  caPath?: string | undefined;
};

/** Swappable so dev, file and ACME differ by config alone. */
export interface CertProvider {
  readonly name: "selfsigned" | "file" | "acme";
  ensure(domains: string[]): Promise<CertBundle>;
  /** True when the material should be renewed now. */
  isDue(bundle: CertBundle, now?: number): boolean;
}
