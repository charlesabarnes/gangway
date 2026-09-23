import { describe, expect, test } from "bun:test";
import {
  ALLOW_LOCAL_ENV,
  DockerGuardError,
  assertHostDaemon,
  assertRemoteDaemon,
  checkDaemon,
  describeDaemon,
  localDockerAllowed,
  looksLikeDockerDesktop,
  type DockerInfo,
} from "../../src/docker/guard.ts";

/* Captured shapes. The strings matter more than they look: the whole guard is a
   judgement about what a real daemon puts in these two fields. */
const DESKTOP_MAC: DockerInfo = {
  Name: "docker-desktop",
  OperatingSystem: "Docker Desktop",
  OSType: "linux",
  ServerVersion: "28.0.4",
  Architecture: "aarch64",
};

const DESKTOP_VERSIONED: DockerInfo = {
  Name: "docker-desktop",
  OperatingSystem: "Docker Desktop 4.39.0 (184744)",
  OSType: "linux",
  ServerVersion: "27.5.1",
};

const REMOTE_HOST: DockerInfo = {
  Name: "docker-host",
  OperatingSystem: "Debian GNU/Linux 12 (bookworm)",
  OSType: "linux",
  ServerVersion: "27.3.1",
  Architecture: "x86_64",
  NCPU: 24,
};

const OTHER_LINUX: DockerInfo = {
  Name: "preview-host-2",
  OperatingSystem: "Ubuntu 24.04.1 LTS",
  OSType: "linux",
  ServerVersion: "27.3.1",
};

const EMPTY: Record<string, string | undefined> = {};
const ALLOWED: Record<string, string | undefined> = { [ALLOW_LOCAL_ENV]: "1" };

describe("Docker Desktop detection", () => {
  test("the plain OperatingSystem string", () => {
    expect(looksLikeDockerDesktop(DESKTOP_MAC)).toBe(true);
  });

  test("the version-suffixed OperatingSystem string", () => {
    expect(looksLikeDockerDesktop(DESKTOP_VERSIONED)).toBe(true);
  });

  test("case does not rescue it", () => {
    expect(looksLikeDockerDesktop({ OperatingSystem: "DOCKER DESKTOP 5.0" })).toBe(true);
    expect(looksLikeDockerDesktop({ OperatingSystem: "docker desktop" })).toBe(true);
  });

  /* The second signal exists so a Docker Desktop release that rewords OperatingSystem
     cannot silently disarm the guard. */
  test("Name alone is enough when OperatingSystem is reworded", () => {
    expect(looksLikeDockerDesktop({ Name: "docker-desktop", OperatingSystem: "Linux" })).toBe(true);
  });

  test("real Linux daemons are not mistaken for Desktop", () => {
    expect(looksLikeDockerDesktop(REMOTE_HOST)).toBe(false);
    expect(looksLikeDockerDesktop(OTHER_LINUX)).toBe(false);
    expect(looksLikeDockerDesktop({})).toBe(false);
    expect(looksLikeDockerDesktop({ OperatingSystem: "Docker Engine - Community" })).toBe(false);
  });

  /* "desktop-linux" is a Docker context name, not a daemon OperatingSystem.
     Matching on it would be matching the wrong string. */
  test("a host merely named like a desktop context is not Desktop", () => {
    expect(looksLikeDockerDesktop({ Name: "desktop-linux", OperatingSystem: "Debian 12" })).toBe(
      false,
    );
  });
});

describe("refusing Docker Desktop", () => {
  test("assertRemoteDaemon throws on Desktop", () => {
    expect(() => assertRemoteDaemon(DESKTOP_MAC, null, EMPTY)).toThrow(DockerGuardError);
  });

  test("the error says which daemon answered, so the cause is readable", () => {
    let err: unknown;
    try {
      assertRemoteDaemon(DESKTOP_MAC, null, EMPTY);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DockerGuardError);
    const g = err as DockerGuardError;
    expect(g.reason).toBe("docker-desktop");
    expect(g.message).toContain("Docker Desktop");
    expect(g.message).toContain("DOCKER_CONTEXT");
    expect(g.detail?.["name"]).toBe("docker-desktop");
  });

  test("a remote daemon passes with no expectName", () => {
    expect(assertRemoteDaemon(REMOTE_HOST, null, EMPTY)).toEqual({ ok: true, name: "docker-host" });
    expect(assertRemoteDaemon(OTHER_LINUX, undefined, EMPTY)).toEqual({
      ok: true,
      name: "preview-host-2",
    });
  });

  test("an info payload with nothing in it is allowed through the Desktop check", () => {
    // We cannot prove a daemon is remote; we can only refuse the ones we recognise.
    expect(checkDaemon({}, null, EMPTY).ok).toBe(true);
  });
});

describe("the escape hatch", () => {
  test("GANGWAY_ALLOW_LOCAL_DOCKER=1 permits Desktop", () => {
    expect(assertRemoteDaemon(DESKTOP_MAC, null, ALLOWED)).toEqual({
      ok: true,
      name: "docker-desktop",
    });
  });

  test("only the literal 1 opens it", () => {
    for (const v of ["true", "yes", "0", "", "01", " 1"]) {
      expect(localDockerAllowed({ [ALLOW_LOCAL_ENV]: v })).toBe(false);
      expect(() => assertRemoteDaemon(DESKTOP_MAC, null, { [ALLOW_LOCAL_ENV]: v })).toThrow(
        DockerGuardError,
      );
    }
    expect(localDockerAllowed({ [ALLOW_LOCAL_ENV]: "1" })).toBe(true);
  });

  test("it does NOT open the name check — wrong remote is never benign", () => {
    expect(() => assertRemoteDaemon(DESKTOP_MAC, "docker-host", ALLOWED)).toThrow(/wrong daemon/);
  });
});

describe("expectName", () => {
  test("a match passes", () => {
    expect(assertRemoteDaemon(REMOTE_HOST, "docker-host", EMPTY)).toEqual({
      ok: true,
      name: "docker-host",
    });
  });

  test("a mismatch throws with reason name-mismatch", () => {
    const r = checkDaemon(OTHER_LINUX, "docker-host", EMPTY);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.reason).toBe("name-mismatch");
    expect(r.error.detail).toMatchObject({ name: "preview-host-2", expectName: "docker-host" });
  });

  test("null, undefined and empty expectName all mean unchecked", () => {
    for (const e of [null, undefined, ""]) {
      expect(checkDaemon(OTHER_LINUX, e, EMPTY).ok).toBe(true);
    }
  });

  test("a daemon with no Name fails a set expectName rather than passing", () => {
    const r = checkDaemon({ OperatingSystem: "Ubuntu 24.04" }, "docker-host", EMPTY);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.reason).toBe("name-mismatch");
  });

  test("matching is exact — no trimming, no case folding", () => {
    expect(
      checkDaemon({ Name: "Docker-Host", OperatingSystem: "Ubuntu" }, "docker-host", EMPTY).ok,
    ).toBe(false);
    expect(
      checkDaemon({ Name: "docker-host ", OperatingSystem: "Ubuntu" }, "docker-host", EMPTY).ok,
    ).toBe(false);
  });
});

/* The scenario the guard exists for, end to end: DOCKER_HOST is set to docker-host but
   DOCKER_CONTEXT=desktop-linux quietly wins, so `docker info` answers from the local machine.
   Without this check the next call creates containers there and reports success. */
describe("the actual accident", () => {
  test("DOCKER_CONTEXT beating DOCKER_HOST is caught by both checks", () => {
    const host = { id: "docker-host", expectName: "docker-host" };
    expect(() => assertHostDaemon(host, DESKTOP_MAC, EMPTY)).toThrow(DockerGuardError);
  });

  test("the desktop reason is reported first, because that is the headline", () => {
    let err: DockerGuardError | undefined;
    try {
      assertHostDaemon({ id: "docker-host", expectName: "docker-host" }, DESKTOP_MAC, EMPTY);
    } catch (e) {
      err = e as DockerGuardError;
    }
    expect(err?.reason).toBe("docker-desktop");
    expect(err?.message).toContain("host docker-host");
    expect(err?.detail?.["hostId"]).toBe("docker-host");
  });

  test("guard errors carry an HTTP status, so they surface as problem+json", () => {
    const r = checkDaemon(DESKTOP_MAC, null, EMPTY);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.status).toBe(503);
    expect(r.error.toProblem()["detail"]).toContain("Docker Desktop");
  });

  test("a correctly configured docker-host host passes cleanly", () => {
    expect(
      assertHostDaemon({ id: "docker-host", expectName: "docker-host" }, REMOTE_HOST, EMPTY),
    ).toEqual({ ok: true, name: "docker-host" });
  });
});

describe("describeDaemon", () => {
  test("one line, no credentials", () => {
    expect(describeDaemon(REMOTE_HOST)).toBe(
      "docker-host / Debian GNU/Linux 12 (bookworm) / docker 27.3.1 / x86_64",
    );
  });

  test("survives an empty payload", () => {
    expect(describeDaemon({})).toBe("? / ?");
  });
});
