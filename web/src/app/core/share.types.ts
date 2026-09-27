/** A preview's public link through a Cloudflare quick tunnel. */
export type Share = {
  previewId: string;
  url: string;
  host: string;
  provider: string;
  startedAt: number;
  expiresAt: number;
};

/** GET/POST/DELETE /v1/previews/:id/share. */
export type ShareStatus = {
  available: boolean;
  local: boolean;
  maxTtlMs: number;
  share: Share | null;
};
