import { randomBytes } from "node:crypto";
import type { OAuthClientsRepo } from "../db/repos/oauth-clients.ts";
import {
  ClientMetadataError,
  cleanClientName,
  type ClientMetadata,
  type ClientMetadataStore,
} from "./client-metadata.ts";

/** Every client_id gangway issues starts with this; anything else is a metadata document URL. */
export const REGISTERED_PREFIX = "gwc_";

const MAX_CLIENTS = 5_000;
const UNUSED_FOR_MS = 86_400_000;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
// Schemes a redirect may never use, whatever the client says; a private-use scheme such as
// cursor:// or a reverse-domain one is fine (RFC 8252 §7.1).
const BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "about:",
  "blob:",
  "ftp:",
  "ws:",
  "wss:",
]);

export type RegistrationErrorCode = "invalid_redirect_uri" | "invalid_client_metadata";

export class RegistrationError extends Error {
  readonly code: RegistrationErrorCode | "temporarily_unavailable";

  constructor(code: RegistrationErrorCode | "temporarily_unavailable", message: string) {
    super(message);
    this.code = code;
  }
}

export type RegistrationResponse = {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
};

function checkRedirect(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    throw new RegistrationError("invalid_redirect_uri", "each redirect_uri is a string URL");
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RegistrationError("invalid_redirect_uri", `${raw} is not an absolute URL`);
  }
  if (u.hash) {
    throw new RegistrationError("invalid_redirect_uri", `${raw} has a fragment`);
  }
  if (BLOCKED_SCHEMES.has(u.protocol)) {
    throw new RegistrationError("invalid_redirect_uri", `${u.protocol} redirects are refused`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "http:" && !loopback) {
    throw new RegistrationError(
      "invalid_redirect_uri",
      `${raw}: plain http is only for localhost, 127.0.0.1 or [::1]`,
    );
  }
  return raw;
}

function subsetOf(value: unknown, allowed: readonly string[], field: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && allowed.includes(v))) {
    throw new RegistrationError(
      "invalid_client_metadata",
      `${field} may only list ${allowed.join(", ")}`,
    );
  }
}

/**
 * Reads an RFC 7591 registration. Only public clients are issued: a client that asks for a
 * secret-based token_endpoint_auth_method is registered as "none" and told so in the answer.
 */
export function parseRegistration(body: unknown): { clientName: string; redirectUris: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RegistrationError(
      "invalid_client_metadata",
      "send the client metadata as a JSON object",
    );
  }
  const d = body as Record<string, unknown>;
  const uris = d["redirect_uris"];
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20) {
    throw new RegistrationError("invalid_redirect_uri", "redirect_uris needs 1 to 20 URLs");
  }
  const redirectUris = [...new Set(uris.map(checkRedirect))];
  subsetOf(d["grant_types"], GRANT_TYPES, "grant_types");
  subsetOf(d["response_types"], ["code"], "response_types");
  const name = typeof d["client_name"] === "string" ? cleanClientName(d["client_name"]) : "";
  return {
    clientName: name || new URL(redirectUris[0]!).hostname || "An MCP client",
    redirectUris,
  };
}

export class ClientRegistry {
  readonly #repo: OAuthClientsRepo;
  readonly #now: () => number;

  constructor(repo: OAuthClientsRepo, now: () => number = Date.now) {
    this.#repo = repo;
    this.#now = now;
  }

  register(body: unknown): RegistrationResponse {
    const { clientName, redirectUris } = parseRegistration(body);
    const now = this.#now();
    if (this.#repo.count() >= MAX_CLIENTS) {
      this.#repo.purgeUnused(now - UNUSED_FOR_MS);
      if (this.#repo.count() >= MAX_CLIENTS) {
        throw new RegistrationError(
          "temporarily_unavailable",
          "too many registered clients; try again later",
        );
      }
    }
    const id = `${REGISTERED_PREFIX}${randomBytes(24).toString("base64url")}`;
    this.#repo.create({ id, clientName, redirectUris, createdAt: now });
    return {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: GRANT_TYPES,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  get(clientId: string): ClientMetadata {
    const c = this.#repo.get(clientId);
    if (!c) {
      throw new ClientMetadataError("no client is registered with that client_id");
    }
    this.#repo.touch(clientId, this.#now());
    return {
      clientId: c.id,
      clientName: c.clientName,
      redirectUris: c.redirectUris,
      registered: true,
    };
  }

  purgeUnused(): number {
    return this.#repo.purgeUnused(this.#now() - UNUSED_FOR_MS);
  }
}

/** Finds a client by either route: a gwc_ id this server issued, or a metadata document URL. */
export function clientResolver(
  registry: ClientRegistry,
  documents: Pick<ClientMetadataStore, "get">,
): Pick<ClientMetadataStore, "get"> {
  return {
    get: async (clientId) =>
      clientId.startsWith(REGISTERED_PREFIX) ? registry.get(clientId) : documents.get(clientId),
  };
}
