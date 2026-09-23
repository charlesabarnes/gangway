import { Audit } from "../../src/audit/audit.ts";
import { Accounts } from "../../src/auth/accounts.ts";
import { LoginLimiter } from "../../src/auth/limiter.ts";
import { Passwords } from "../../src/auth/password.ts";
import { RolePermissions } from "../../src/auth/roles.ts";
import { Sessions } from "../../src/auth/sessions.ts";
import {
  AuditRepo,
  RolesRepo,
  SessionsRepo,
  TokensRepo,
  UsersRepo,
} from "../../src/db/repos/index.ts";
import { tempDb } from "./db.ts";
import { silentLogger } from "./logger.ts";

export const META = { ip: "203.0.113.7", userAgent: "test-agent" };
export const PASSWORD = "correct horse battery staple";

/** Real SQLite, real services, a clock you can move, and scrypt cheap enough to run hundreds of times. */
export function setupAccounts() {
  const { db } = tempDb();

  const clock = { t: 1_700_000_000_000 };
  const now = () => clock.t;
  const users = new UsersRepo(db, now);
  const rolesRepo = new RolesRepo(db);
  const auditRepo = new AuditRepo(db, now);
  const audit = new Audit(auditRepo, silentLogger());
  const roles = new RolePermissions(rolesRepo, audit);
  const sessionsRepo = new SessionsRepo(db, now);
  const sessions = new Sessions(sessionsRepo, roles, now);
  const passwords = new Passwords({ ln: 10 });
  const limiter = new LoginLimiter({}, now);
  const accounts = new Accounts({
    db,
    users,
    roles: rolesRepo,
    sessions,
    passwords,
    limiter,
    audit,
    now,
  });
  const actions = () =>
    auditRepo
      .page({ limit: 200 })
      .entries.map((e) => e.action)
      .reverse();

  return {
    db,
    clock,
    now,
    users,
    rolesRepo,
    roles,
    sessionsRepo,
    sessions,
    auditRepo,
    audit,
    passwords,
    limiter,
    accounts,
    actions,
    tokensRepo: new TokensRepo(db, now),
    /** The first admin, made the way production makes it. */
    admin: () => accounts.setupFirstAdmin("ada@example.com", PASSWORD, META),
  };
}
