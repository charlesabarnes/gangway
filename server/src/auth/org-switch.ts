import type { MyOrg } from "@gangway/shared/orgs-api";
import type { AuditSink } from "../audit/audit.ts";
import type { UsersRepo } from "../db/repos/users.ts";
import { forbidden, notFound } from "../errors.ts";
import type { Actor } from "./actor.ts";
import type { Sessions } from "./sessions.ts";

export type OrgSwitchDeps = {
  users: Pick<UsersRepo, "memberships">;
  sessions: Pick<Sessions, "rotate">;
  audit: AuditSink;
};

type SessionActor = Extract<Actor, { kind: "user" }>;

// A token, a grant or a workflow acts in the org it was made for; only a session may move.
const signedIn = (actor: Actor): SessionActor => {
  if (actor.kind !== "user") {
    throw forbidden("only a signed-in person switches org; a token keeps the org it was made in");
  }
  return actor;
};

/** The orgs a signed-in person belongs to, and moving their session between them. */
export class OrgSwitch {
  readonly #d: OrgSwitchDeps;

  constructor(d: OrgSwitchDeps) {
    this.#d = d;
  }

  list(actor: Actor): MyOrg[] {
    const person = signedIn(actor);
    return this.#d.users
      .memberships(person.userId)
      .map((m) => ({ ...m.org, role: m.role, current: m.org.id === person.orgId }));
  }

  /** A new session secret bound to `orgId`; someone not in that org gets the same 404 as no org. */
  switchTo(
    actor: Actor,
    orgId: string,
    meta: { ip: string | null; userAgent: string | null },
  ): { org: MyOrg; secret: string } {
    const person = signedIn(actor);
    const found = this.#d.users.memberships(person.userId).find((m) => m.org.id === orgId);
    if (!found) {
      throw notFound("no such org");
    }
    const rotated = this.#d.sessions.rotate(person.sessionId, orgId, meta);
    if (!rotated) {
      throw notFound("no such session");
    }
    this.#d.audit.record({ ...person, orgId }, "auth.org.switched", person.userId, {
      old: { orgId: person.orgId },
      new: { orgId },
    });
    return { org: { ...found.org, role: found.role, current: true }, secret: rotated.secret };
  }
}
