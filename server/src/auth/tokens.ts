import { randomBytes } from "node:crypto";
import type { ApiToken } from "@gangway/shared/domain";
import { SCOPE_PERMISSIONS, type Permission, type Scope } from "@gangway/shared/permissions";
import type { AuditSink } from "../audit/audit.ts";
import type { TokensRepo } from "../db/repos/tokens.ts";
import { forbidden, notFound, unprocessable } from "../errors.ts";
import { parseDuration } from "../util/duration.ts";
import { ulid } from "../util/ulid.ts";
import {
  can,
  ENV_ADMIN_TOKEN_ID,
  permissionsForScopes,
  type Actor,
  type TokenVerifier,
} from "./actor.ts";
import type { RolePermissions } from "./roles.ts";
import { sha256 } from "../util/hash.ts";

const SHAPE = /^gw_[A-Za-z0-9_-]{43}$/;
const PREFIX_LEN = 11;
const TOUCH_EVERY_MS = 60_000;

const hashOf = (secret: string) => sha256(secret, "hex");

export class Tokens {
  readonly #repo: TokensRepo;
  readonly #roles: RolePermissions;
  readonly #audit: AuditSink;
  readonly #now: () => number;

  constructor(
    repo: TokensRepo,
    roles: RolePermissions,
    audit: AuditSink,
    now: () => number = Date.now,
  ) {
    this.#repo = repo;
    this.#roles = roles;
    this.#audit = audit;
    this.#now = now;
  }

  readonly verify: TokenVerifier = (presented) => {
    if (!SHAPE.test(presented)) return null;
    const now = this.#now();
    const found = this.#repo.findActiveByHash(hashOf(presented), now);
    if (!found) return null;
    this.#repo.touch(found.token.id, now - TOUCH_EVERY_MS, now);

    const { token, owner } = found;
    const bundle = permissionsForScopes(token.scopes);
    if (!owner)
      return { kind: "token", tokenId: token.id, scopes: token.scopes, permissions: bundle };
    const role = this.#roles.for(owner.roleId);
    const permissions = new Set<Permission>([...bundle].filter((p) => role.has(p)));
    return {
      kind: "token",
      tokenId: token.id,
      scopes: token.scopes,
      permissions,
      userId: owner.id,
    };
  };

  mint(
    actor: Actor,
    input: { name: string; scopes: readonly Scope[]; expiresIn?: string | undefined },
  ): { token: ApiToken; secret: string } {
    const owner =
      actor.kind === "user"
        ? actor.userId
        : actor.kind === "token" && actor.tokenId === ENV_ADMIN_TOKEN_ID
          ? null
          : undefined;
    if (owner === undefined)
      throw forbidden(
        "an API token cannot create API tokens; log in, or use the server's admin token",
      );

    const scopes = [...new Set(input.scopes)];
    for (const scope of scopes) {
      const missing = SCOPE_PERMISSIONS[scope].filter((p) => !can(actor, p));
      if (missing.length > 0)
        throw unprocessable(`your role does not cover the "${scope}" scope`, { scope, missing });
    }

    let expiresAt: number | null = null;
    if (input.expiresIn !== undefined) {
      const ms = parseDuration(input.expiresIn);
      if (ms === null || ms <= 0)
        throw unprocessable(
          `expiresIn ${JSON.stringify(input.expiresIn)} is not a duration like 12h or 90d`,
        );
      expiresAt = this.#now() + ms;
    }

    const secret = `gw_${randomBytes(32).toString("base64url")}`;
    const token = this.#repo.create({
      id: ulid(this.#now()),
      name: input.name,
      prefix: secret.slice(0, PREFIX_LEN),
      tokenHash: hashOf(secret),
      scopes,
      userId: owner,
      expiresAt,
    });
    this.#audit.record(actor, "token.created", token.id, {
      new: { name: token.name, scopes, userId: owner, expiresAt: token.expiresAt },
    });
    return { token, secret };
  }

  list(actor: Actor, o: { all?: boolean } = {}): ApiToken[] {
    if (o.all) {
      if (!can(actor, "tokens.manage_all"))
        throw forbidden('requires the "tokens.manage_all" permission');
      return this.#repo.listAll();
    }
    return actor.kind === "user"
      ? this.#repo.listForUser(actor.userId)
      : can(actor, "tokens.manage_all")
        ? this.#repo.listAll()
        : [];
  }

  revoke(actor: Actor, id: string): ApiToken {
    const token = this.#repo.get(id);
    const mine = token !== undefined && actor.kind === "user" && token.userId === actor.userId;
    if (!token || !(mine || can(actor, "tokens.manage_all")))
      throw notFound(`no such token: ${id}`);
    if (this.#repo.revoke(id, this.#now())) {
      this.#audit.record(actor, "token.revoked", id, {
        old: { name: token.name, scopes: token.scopes, userId: token.userId },
      });
    }
    return this.#repo.get(id)!;
  }
}
