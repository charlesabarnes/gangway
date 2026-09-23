/**
 * The audit log: who did what, to what, and what it was before.
 *
 * Written from the service layer, never from a route: the webhook receiver and the MCP
 * tools deploy too, and they do not come through a route.
 *
 * `record` is synchronous and never throws. The action it describes has already happened,
 * and failing the request because the note could not be written would make the log a
 * liability. A failure is logged loudly instead.
 *
 * Everything is redacted on the way in. One trap: `redact()` treats a field named `key` as
 * a secret, so a settings change must be recorded as `{ setting: "surfaces.ui" }`.
 */
import { auditActor, type Actor } from "../auth/actor.ts";
import type { AuditRepo } from "../db/repos/audit.ts";
import { redact, type Logger } from "../logger.ts";

export type AuditAction =
  | "preview.deploy"
  | "preview.destroy"
  | "preview.redeploy"
  | "preview.data.query"
  | "preview.password"
  | "auth.setup"
  | "auth.login"
  | "auth.login.failed"
  | "auth.login.blocked"
  | "auth.logout"
  | "auth.password.changed"
  | "user.created"
  | "user.updated"
  | "role.permissions.changed"
  | "settings.changed"
  | "surface.changed"
  | "github.connected"
  | "repo.updated"
  | "repo.deleted"
  | "repo.env.changed"
  | "secrets.changed"
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "project.env.changed"
  | "template.created"
  | "template.updated"
  | "template.deleted"
  | "token.created"
  | "token.revoked"
  | "oauth.grant.created"
  | "oauth.grant.revoked";

export type AuditChange = { old?: unknown; new?: unknown };

/** What the service layer depends on, so a context built without a database still works. */
export interface AuditSink {
  record(
    actor: Actor | null,
    action: AuditAction,
    target: string | null,
    change?: AuditChange,
  ): void;
}

export class Audit implements AuditSink {
  readonly #repo: AuditRepo;
  readonly #logger: Logger;

  constructor(repo: AuditRepo, logger: Logger) {
    this.#repo = repo;
    this.#logger = logger;
  }

  /**
   * `actor` is null when nobody is authenticated -- a failed login, the first-run setup.
   * The schema has no "anonymous" actor type, so those are `system` with no id, and the
   * target says who it was about.
   */
  record(
    actor: Actor | null,
    action: AuditAction,
    target: string | null,
    change: AuditChange = {},
  ): void {
    try {
      const who = actor ? auditActor(actor) : { type: "system" as const, id: null };
      this.#repo.append({
        actorType: who.type,
        actorId: who.id,
        action,
        target,
        old: change.old === undefined ? undefined : redact(change.old),
        new: change.new === undefined ? undefined : redact(change.new),
      });
    } catch (err) {
      this.#logger.error("audit write failed; the action itself succeeded", {
        action,
        target,
        err,
      });
    }
  }
}
