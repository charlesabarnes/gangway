import { randomBytes } from "node:crypto";
import type { User } from "@gangway/shared/domain";
import { must } from "@gangway/shared/must";
import type { AuditSink } from "../audit/audit.ts";
import type { LinkPurpose, UserLinksRepo } from "../db/repos/user-links.ts";
import type { UsersRepo } from "../db/repos/users.ts";
import type { Db } from "../db/types.ts";
import { conflict, errorMessage, notFound, rateLimited } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { Mail, Mailer } from "../mail/mailer.ts";
import { sha256 } from "../util/hash.ts";
import type { LoggedIn, RequestMeta } from "./accounts.ts";
import type { Actor } from "./actor.ts";
import type { LoginLimiter } from "./limiter.ts";
import type { Passwords } from "./password.ts";
import type { Sessions } from "./sessions.ts";

const HOUR = 3_600_000;
export const LINK_TTL_MS: Record<LinkPurpose, number> = { invite: 7 * 24 * HOUR, reset: HOUR };

export type EmailLinksDeps = {
  db: Pick<Db, "transaction">;
  users: UsersRepo;
  links: UserLinksRepo;
  sessions: Sessions;
  passwords: Passwords;
  mailer: Mailer;
  audit: AuditSink;
  /** Counts every reset request, so one address gets a few emails and then waits. */
  limiter: LoginLimiter;
  appOrigin: () => string;
  logger: Logger;
  onCredentialsRevoked?: ((userId: string) => void) | undefined;
};

const GONE = "that link has expired or was already used; ask for a new one";

const idOf = (secret: string) => sha256(secret, "hex");

/** Emailed one-use links: an invitation to set a first password, and a password reset. */
export class EmailLinks {
  readonly #d: EmailLinksDeps;

  constructor(d: EmailLinksDeps) {
    this.#d = d;
  }

  get available(): boolean {
    return this.#d.mailer.configured;
  }

  // The answer and its timing are the same whether or not the account exists: the email is
  // sent in the background, and a failure is only logged.
  requestReset(email: string, meta: RequestMeta): void {
    const { users, limiter, audit, logger } = this.#d;
    if (!this.available) {
      throw conflict("password resets by email are not set up on this server");
    }
    const verdict = limiter.check(meta.ip, email);
    if (!verdict.ok) {
      throw rateLimited(verdict.retryAfterSec, "a link was sent a moment ago; check your email");
    }
    limiter.fail(meta.ip, email);

    const user = users.getByEmail(email);
    // An SSO-only account has no password to reset; the answer looks the same either way.
    if (!user || user.disabled || users.isSsoOnly(user.id)) {
      audit.record(null, "auth.reset.requested", email, { new: { ip: meta.ip, sent: false } });
      return;
    }
    // Someone invited who lost the email gets the invitation again, not a reset.
    const purpose: LinkPurpose = user.invited ? "invite" : "reset";
    audit.record(null, "auth.reset.requested", user.id, { new: { ip: meta.ip, sent: purpose } });
    this.#send(user, purpose, null).catch((e: unknown) => {
      logger.warn("could not email a password link", { userId: user.id, err: errorMessage(e) });
    });
  }

  /** An admin's resend: an invitation while the account has no password, else a reset. */
  async sendFor(actor: Actor, user: User): Promise<LinkPurpose> {
    if (user.disabled) {
      throw conflict("the account is disabled; enable it first");
    }
    if (this.#d.users.isSsoOnly(user.id)) {
      throw conflict("the account signs in only with single sign-on; it has no password to set");
    }
    const purpose: LinkPurpose = user.invited ? "invite" : "reset";
    await this.#send(user, purpose, actor);
    this.#d.audit.record(actor, "user.link.sent", user.id, { new: { purpose } });
    return purpose;
  }

  /** With passwords off: says where to sign in. It carries no secret, so a resend is harmless. */
  async sendSsoNotice(actor: Actor, user: User, label: string): Promise<void> {
    if (user.disabled) {
      throw conflict("the account is disabled; enable it first");
    }
    const origin = this.#d.appOrigin();
    const host = new URL(origin).host;
    const inviter = actor.kind === "user" ? this.#d.users.get(actor.userId)?.email : undefined;
    await this.#d.mailer.send({
      to: user.email,
      subject: `You have access to gangway at ${host}`,
      text: [
        `${inviter ?? "An admin"} added you to gangway at ${host}.`,
        "",
        `Sign in there with "${label}", using this email address:`,
        `${origin}/login`,
      ].join("\n"),
      purpose: "invite",
      link: `${origin}/login`,
    });
    this.#d.audit.record(actor, "user.link.sent", user.id, { new: { purpose: "sso" } });
  }

  inspect(secret: string): { email: string; purpose: LinkPurpose } {
    const link = this.#d.links.get(idOf(secret));
    const user = link && this.#d.users.get(link.userId);
    if (!link || !user || user.disabled) {
      throw notFound(GONE);
    }
    return { email: user.email, purpose: link.purpose };
  }

  async redeem(secret: string, password: string, meta: RequestMeta): Promise<LoggedIn> {
    const { db, users, links, sessions, passwords, audit } = this.#d;
    const id = idOf(secret);
    this.inspect(secret);
    // Db.transaction is synchronous, so hashing happens before it and nothing inside awaits.
    const credentials = await passwords.hash(password);
    const { user, purpose } = db.transaction(() => {
      const link = links.get(id);
      const user = link && users.get(link.userId);
      if (!link || !user || user.disabled || !links.consume(id)) {
        throw notFound(GONE);
      }
      users.setPassword(user.id, credentials);
      return { user: must(users.get(user.id), "the user just updated"), purpose: link.purpose };
    });

    sessions.revokeAllFor(user.id);
    this.#d.onCredentialsRevoked?.(user.id);
    const { secret: session, session: s } = sessions.issue(user.id, meta, users.orgsOf(user.id)[0]);
    audit.record(
      {
        kind: "user",
        userId: user.id,
        roleId: user.roleId,
        permissions: new Set(),
        sessionId: s.id,
        orgId: s.orgId,
      },
      purpose === "invite" ? "auth.invite.accepted" : "auth.password.reset",
      user.id,
      { new: { ip: meta.ip } },
    );
    return { user, secret: session };
  }

  async #send(user: User, purpose: LinkPurpose, by: Actor | null): Promise<void> {
    const secret = randomBytes(32).toString("base64url");
    this.#d.links.create(idOf(secret), user.id, purpose, LINK_TTL_MS[purpose]);
    const origin = this.#d.appOrigin();
    const url = `${origin}/set-password#${secret}`;
    const inviter = by?.kind === "user" ? this.#d.users.get(by.userId)?.email : undefined;
    await this.#d.mailer.send({
      ...message(purpose, user.email, { url, host: new URL(origin).host, inviter }),
      purpose,
      link: url,
    });
  }
}

// Plain text: it survives every client and spam filter, and the link is the whole message.
function message(
  purpose: LinkPurpose,
  to: string,
  { url, host, inviter }: { url: string; host: string; inviter: string | undefined },
): Mail {
  if (purpose === "invite") {
    return {
      to,
      subject: `You're invited to gangway at ${host}`,
      text: [
        `${inviter ?? "An admin"} added you to gangway at ${host}.`,
        "",
        "Choose a password to finish setting up your account:",
        url,
        "",
        "The link works once and expires in 7 days. Your email address is your login.",
      ].join("\n"),
    };
  }
  return {
    to,
    subject: `Reset your gangway password`,
    text: [
      `Someone asked to reset the password for ${to} on gangway at ${host}.`,
      "",
      "Choose a new password:",
      url,
      "",
      "The link works once and expires in an hour. Using it logs you out everywhere else.",
      "If you did not ask for this, ignore this email; your password has not changed.",
    ].join("\n"),
  };
}
