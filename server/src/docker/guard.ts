/**
 * Checks a daemon's `docker info` before anything is created on it. With a Docker Desktop
 * context active, an unset or overridden `DOCKER_HOST` does not error -- it succeeds against
 * the wrong daemon, and previews land on the local machine instead of the real host.
 *
 * Two independent checks, because each catches what the other misses:
 *
 *  1. The daemon is Docker Desktop -- catches the case where no host record has an
 *     `expectName` yet. Overridable with `GANGWAY_ALLOW_LOCAL_DOCKER=1`.
 *  2. `Info.Name` matches the host record's `expectName` -- catches the wrong remote, which
 *     check 1 cannot see. No override: there is no benign reading of a mismatch.
 */
import { AppError } from "../errors.ts";

/** The fields of `GET /info` we actually read. Deliberately structural — no dockerode. */
export type DockerInfo = {
  Name?: string | undefined;
  OperatingSystem?: string | undefined;
  OSType?: string | undefined;
  ServerVersion?: string | undefined;
  Architecture?: string | undefined;
  NCPU?: number | undefined;
  MemTotal?: number | undefined;
};

export type GuardReason = "docker-desktop" | "name-mismatch";

export class DockerGuardError extends AppError {
  readonly reason: GuardReason;

  constructor(reason: GuardReason, message: string, detail?: Record<string, unknown>) {
    super("unavailable", message, { reason, ...(detail ?? {}) });
    this.name = "DockerGuardError";
    this.reason = reason;
  }
}

export type GuardOk = { ok: true; name: string | null };
export type GuardResult = GuardOk | { ok: false; error: DockerGuardError };

export const ALLOW_LOCAL_ENV = "GANGWAY_ALLOW_LOCAL_DOCKER";

type Env = Readonly<Record<string, string | undefined>>;

/** The opt-in is exactly `1`. "true", "yes" and "0" are all refusals, on purpose. */
export function localDockerAllowed(env: Env = process.env): boolean {
  return env[ALLOW_LOCAL_ENV] === "1";
}

/**
 * Docker Desktop is identifiable two ways and either is accepted, because a version bump
 * that reworded `OperatingSystem` must not silently disarm the guard:
 *   - `OperatingSystem: "Docker Desktop"` / `"Docker Desktop 4.39.0 (…)"`
 *   - `Name: "docker-desktop"` — the VM's hostname, stable across releases.
 */
export function looksLikeDockerDesktop(info: DockerInfo): boolean {
  const os = (info.OperatingSystem ?? "").toLowerCase();
  if (os.includes("docker desktop")) return true;
  return (info.Name ?? "").toLowerCase() === "docker-desktop";
}

/** Non-throwing form. `assertRemoteDaemon` is this plus a throw. */
export function checkDaemon(
  info: DockerInfo,
  expectName?: string | null,
  env: Env = process.env,
): GuardResult {
  const name = info.Name ?? null;

  // Desktop first: when both checks fail it is the headline, and the one an operator
  // needs to read to understand that the request never left the local machine.
  if (looksLikeDockerDesktop(info) && !localDockerAllowed(env)) {
    return {
      ok: false,
      error: new DockerGuardError(
        "docker-desktop",
        `refusing to use a Docker Desktop daemon (OperatingSystem=${JSON.stringify(info.OperatingSystem ?? null)}, Name=${JSON.stringify(name)}). ` +
          `DOCKER_HOST is probably unset or beaten by DOCKER_CONTEXT. Set ${ALLOW_LOCAL_ENV}=1 if this is really what you want.`,
        { operatingSystem: info.OperatingSystem ?? null, name, expectName: expectName ?? null },
      ),
    };
  }

  if (expectName !== undefined && expectName !== null && expectName !== "" && name !== expectName) {
    return {
      ok: false,
      error: new DockerGuardError(
        "name-mismatch",
        `docker info.Name is ${JSON.stringify(name)} but this host record expects ${JSON.stringify(expectName)} — pointing at the wrong daemon`,
        { name, expectName },
      ),
    };
  }

  return { ok: true, name };
}

/**
 * Refuse to proceed unless this daemon is the one intended. Call before the first
 * mutating operation on a host, and again after a host reconnects.
 */
export function assertRemoteDaemon(
  info: DockerInfo,
  expectName?: string | null,
  env: Env = process.env,
): GuardOk {
  const r = checkDaemon(info, expectName, env);
  if (!r.ok) throw r.error;
  return r;
}

/** The same check, reading `expectName` off the host record where it lives. */
export function assertHostDaemon(
  host: { id: string; expectName: string | null },
  info: DockerInfo,
  env: Env = process.env,
): GuardOk {
  try {
    return assertRemoteDaemon(info, host.expectName, env);
  } catch (err) {
    if (err instanceof DockerGuardError) {
      throw new DockerGuardError(err.reason, `host ${host.id}: ${err.message}`, {
        ...(err.detail ?? {}),
        hostId: host.id,
      });
    }
    throw err;
  }
}

/** A one-line daemon identity for logs. Never includes credentials. */
export function describeDaemon(info: DockerInfo): string {
  const bits = [
    info.Name ?? "?",
    info.OperatingSystem ?? "?",
    info.ServerVersion ? `docker ${info.ServerVersion}` : null,
    info.Architecture ?? null,
  ].filter((b): b is string => b !== null);
  return bits.join(" / ");
}
