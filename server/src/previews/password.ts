/**
 * A preview's password. One function turns what was asked for into what is
 * stored, so a deploy, a change on a running preview and the MCP tool all agree:
 *
 *   inherit   the server-wide default -- which, when that default is `generated`, means
 *             "make this preview its own password now"; otherwise it is resolved per
 *             request (net/gate.ts), so changing the shared password moves every preview
 *   none      open, whatever the default says
 *   set       the person's own password, hashed here
 *   generate  gangway makes one, and it is written once, to the preview's log. It is
 *             stored only as a hash: lose the log line and the answer is a new password.
 *
 * The plain text never reaches the database, the audit log, an event or an API response.
 */
import { randomInt } from "node:crypto";
import type { PasswordChoice } from "@gangway/shared/api";
import type {
  DefaultPasswordMode,
  PasswordLogin,
  Preview,
  PreviewAccess,
} from "@gangway/shared/domain";
import { actorId, type Actor } from "../auth/actor.ts";
import type { Passwords } from "../auth/password.ts";
import type { StoredPreviewPassword } from "../db/repos/previews.ts";
import { notFound, unprocessable } from "../errors.ts";
import type { EntryPassword } from "../routing/table.ts";
import type { PreviewContext } from "./context.ts";

/** What the preview service needs: a hasher and the current default. */
export type PreviewPasswordDeps = {
  passwords: Pick<Passwords, "hash">;
  defaultMode: () => DefaultPasswordMode;
  /**
   * Is a shared password set? Only then does `shared` protect an inheriting preview. Absent: no.
   */
  sharedSet?: () => boolean;
  /** The server-wide "signed-in users skip the password" switch. Absent: off. */
  loginDefault?: () => boolean;
};

/**
 * Who can open a preview right now, resolved the way the gate resolves it: the
 * mode alone cannot say, because `inherit` is open or shut depending on Settings.
 */
export function previewAccess(
  deps: PreviewPasswordDeps | undefined,
  p: Pick<Preview, "password" | "passwordLogin" | "visibility">,
): PreviewAccess {
  if (p.passwordLogin === "only") return "signed-in";
  const password =
    p.password === "set" ||
    p.password === "generated" ||
    (p.password === "inherit" && deps?.defaultMode() === "shared" && deps.sharedSet?.() === true);
  const skips =
    password &&
    (p.passwordLogin === "on" ||
      (p.passwordLogin === "inherit" && deps?.loginDefault?.() === true));
  if (p.visibility === "private") return password && !skips ? "signed-in+password" : "signed-in";
  if (!password) return "open";
  return skips ? "either" : "password";
}

/** No 0/o, 1/l/i: read off a log and typed on a phone. 16 of 31 symbols is ~79 bits. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generatePassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = "";
    for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join("-");
}

export type ResolvedPassword = { stored: StoredPreviewPassword; generated?: string };

export async function resolvePassword(
  deps: PreviewPasswordDeps | undefined,
  choice: PasswordChoice | undefined,
): Promise<ResolvedPassword> {
  const mode = choice?.mode ?? "inherit";
  if (mode === "none") return { stored: { mode: "none", secret: null } };
  const wantsGenerated =
    mode === "generate" || (mode === "inherit" && deps?.defaultMode() === "generated");
  if (mode === "inherit" && !wantsGenerated) return { stored: { mode: "inherit", secret: null } };
  if (!deps) throw unprocessable("password-protected previews are not available on this server");
  if (wantsGenerated) {
    const generated = generatePassword();
    return {
      stored: { mode: "generated", secret: await deps.passwords.hash(generated) },
      generated,
    };
  }
  return {
    stored: { mode: "set", secret: await deps.passwords.hash((choice as { value: string }).value) },
  };
}

/** The route table's view of a stored password. */
export function entryPassword(p: StoredPreviewPassword): EntryPassword {
  if (p.mode === "none") return { mode: "none" };
  if ((p.mode === "set" || p.mode === "generated") && p.secret) return { mode: "own", ...p.secret };
  // `set` with no hash cannot happen through this module; if a row says so, fail towards the
  // default.
  return { mode: "inherit" };
}

/** The one log line a generated password is ever written to. */
export function logGenerated(
  ctx: Pick<PreviewContext, "logs">,
  previewId: string,
  password: string,
): void {
  ctx.logs.append(
    previewId,
    "system",
    `preview password (generated, shown only in this log): ${password}`,
  );
}

/**
 * Change a running preview's password, whether a gangway login gets past it, or both.
 * What is left out is kept. Takes effect on the next request.
 */
export async function setPreviewPassword(
  ctx: PreviewContext,
  input: {
    actor: Actor;
    previewId: string;
    choice?: PasswordChoice | undefined;
    login?: PasswordLogin | undefined;
  },
): Promise<Preview> {
  const before = ctx.previews.get(input.previewId);
  if (!before || before.state === "destroyed" || before.state === "destroying")
    throw notFound(`no such preview: ${input.previewId}`);
  if (input.login === "only" && ctx.privateAvailable?.() === false)
    throw unprocessable(
      "a preview only signed-in people can open needs the web UI, which is switched off (surfaces.ui)",
    );
  const resolved = input.choice ? await resolvePassword(ctx.passwords, input.choice) : undefined;
  const by = actorId(input.actor);
  if (resolved) {
    ctx.previews.setPassword(before.id, resolved.stored);
    ctx.table.setPassword(before.id, entryPassword(resolved.stored));
    ctx.logs.append(before.id, "system", `password ${describe(resolved.stored.mode)} by ${by}`);
    if (resolved.generated) logGenerated(ctx, before.id, resolved.generated);
  }
  if (input.login) {
    ctx.previews.setPasswordLogin(before.id, input.login);
    ctx.table.setPasswordLogin(before.id, input.login);
    const said = {
      inherit: "a gangway login follows the server default",
      on: "people signed in to gangway, or anyone with the password",
      off: "anyone with the password (signed in or not)",
      only: "only people signed in to gangway",
    }[input.login];
    ctx.logs.append(before.id, "system", `who can open it: ${said} (by ${by})`);
  }
  ctx.audit?.record(input.actor, "preview.password", before.id, {
    old: { mode: before.password, login: before.passwordLogin },
    new: {
      mode: resolved?.stored.mode ?? before.password,
      login: input.login ?? before.passwordLogin,
    },
  });
  return ctx.previews.get(before.id)!;
}

function describe(mode: StoredPreviewPassword["mode"]): string {
  switch (mode) {
    case "inherit":
      return "set to follow the server default";
    case "none":
      return "removed";
    case "set":
      return "changed";
    case "generated":
      return "regenerated";
  }
}
