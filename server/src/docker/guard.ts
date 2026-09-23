import { AppError } from "../errors.ts";

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

export function localDockerAllowed(env: Env = process.env): boolean {
  return env[ALLOW_LOCAL_ENV] === "1";
}

// Also match Name, so a reworded OperatingSystem cannot disarm the guard.
export function looksLikeDockerDesktop(info: DockerInfo): boolean {
  const os = (info.OperatingSystem ?? "").toLowerCase();
  if (os.includes("docker desktop")) return true;
  return (info.Name ?? "").toLowerCase() === "docker-desktop";
}

export function checkDaemon(
  info: DockerInfo,
  expectName?: string | null,
  env: Env = process.env,
): GuardResult {
  const name = info.Name ?? null;

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

// The daemon Name must match before anything touches it.
export function assertRemoteDaemon(
  info: DockerInfo,
  expectName?: string | null,
  env: Env = process.env,
): GuardOk {
  const r = checkDaemon(info, expectName, env);
  if (!r.ok) throw r.error;
  return r;
}

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

export function describeDaemon(info: DockerInfo): string {
  const bits = [
    info.Name ?? "?",
    info.OperatingSystem ?? "?",
    info.ServerVersion ? `docker ${info.ServerVersion}` : null,
    info.Architecture ?? null,
  ].filter((b): b is string => b !== null);
  return bits.join(" / ");
}
