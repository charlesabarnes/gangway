import { OAUTH_SCOPES, type OAuthScope } from "./scopes.ts";
import { sameResource, type OAuthErrorCode } from "./token-endpoint.ts";

const DEFAULT_OAUTH_SCOPES: readonly OAuthScope[] = ["read", "deploy"];

const SINGLE_PARAMS = [
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
  "state",
];

export type ParamReader = (k: string) => string | null | undefined;
export type RequestRefusal = { error: OAuthErrorCode; description: string };
export type AuthorizeRequest = { challenge: string; scopes: OAuthScope[] };

export function singleParams(q: URLSearchParams): ParamReader {
  return (k) => {
    const all = q.getAll(k);
    if (all.length === 1) return all[0]!;
    return all.length === 0 ? null : undefined;
  };
}

const refuse = (error: OAuthErrorCode, description: string): RequestRefusal => ({
  error,
  description,
});

function requestedScopes(one: ParamReader): OAuthScope[] | RequestRefusal {
  const asked = (one("scope") ?? "").split(" ").filter((s) => s !== "" && s !== "offline_access");
  const unknown = asked.filter((s) => !(OAUTH_SCOPES as readonly string[]).includes(s));
  if (unknown.length > 0)
    return refuse(
      "invalid_scope",
      `unknown scope: ${unknown.join(" ")}; gangway grants ${OAUTH_SCOPES.join(", ")}`,
    );
  return (asked.length === 0 ? [...DEFAULT_OAUTH_SCOPES] : [...new Set(asked)]) as OAuthScope[];
}

export function checkAuthorizeRequest(
  one: ParamReader,
  ourResource: string,
): AuthorizeRequest | RequestRefusal {
  for (const k of SINGLE_PARAMS) {
    if (one(k) === undefined) return refuse("invalid_request", `${k} was given more than once`);
  }
  if (one("response_type") !== "code")
    return refuse("unsupported_response_type", "only response_type=code is supported");
  const challenge = one("code_challenge");
  if (!challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
    return refuse("invalid_request", "PKCE is required: send code_challenge");
  if (one("code_challenge_method") !== "S256")
    return refuse("invalid_request", "code_challenge_method must be S256");
  const resource = one("resource") ?? ourResource;
  if (!sameResource(resource, ourResource))
    return refuse("invalid_target", `tokens here are only for ${ourResource}`);
  const scopes = requestedScopes(one);
  if (!Array.isArray(scopes)) return scopes;
  return { challenge, scopes };
}
