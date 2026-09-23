import { describe, expect, test } from "bun:test";
import {
  REFUSE_DESKTOP_ENV,
  DockerGuardError,
  assertHostDaemon,
  assertRemoteDaemon,
  checkDaemon,
  daemonEngine,
  describeDaemon,
  desktopRefused,
  looksLikeDockerDesktop,
  type DockerInfo,
} from "../../src/docker/guard.ts";

// Captured from real daemons: the guard is a judgement about exactly these strings.
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

const PODMAN: DockerInfo = {
  Name: "podman-host",
  OperatingSystem: "fedora",
  OSType: "linux",
  ServerVersion: "5.2.2",
  BuildahVersion: "1.37.2",
};

const EMPTY: Record<string, string | undefined> = {};
const REFUSING: Record<string, string | undefined> = { [REFUSE_DESKTOP_ENV]: "1" };

describe("Docker Desktop detection", () => {
  test.each([
    ["plain", DESKTOP_MAC],
    ["version-suffixed", DESKTOP_VERSIONED],
  ])("the %s OperatingSystem string", (_what, info) => {
    expect(looksLikeDockerDesktop(info)).toBe(true);
  });

  test("case does not rescue it", () => {
    expect(looksLikeDockerDesktop({ OperatingSystem: "DOCKER DESKTOP 5.0" })).toBe(true);
    expect(looksLikeDockerDesktop({ OperatingSystem: "docker desktop" })).toBe(true);
  });

  // A second signal, so a release that rewords OperatingSystem cannot disarm the guard.
  test("Name alone is enough when OperatingSystem is reworded", () => {
    expect(looksLikeDockerDesktop({ Name: "docker-desktop", OperatingSystem: "Linux" })).toBe(true);
  });

  test("real Linux daemons are not mistaken for Desktop", () => {
    expect(looksLikeDockerDesktop(REMOTE_HOST)).toBe(false);
    expect(looksLikeDockerDesktop(OTHER_LINUX)).toBe(false);
    expect(looksLikeDockerDesktop({})).toBe(false);
    expect(looksLikeDockerDesktop({ OperatingSystem: "Docker Engine - Community" })).toBe(false);
  });

  // "desktop-linux" is a Docker context name, not a daemon's OperatingSystem.
  test("a host merely named like a desktop context is not Desktop", () => {
    expect(looksLikeDockerDesktop({ Name: "desktop-linux", OperatingSystem: "Debian 12" })).toBe(
      false,
    );
  });
});

describe("Docker Desktop by default", () => {
  test("is an ordinary daemon", () => {
    expect(assertRemoteDaemon(DESKTOP_MAC, null, EMPTY)).toEqual({
      ok: true,
      name: "docker-desktop",
    });
  });

  test("still has to match a set expectName", () => {
    expect(() => assertRemoteDaemon(DESKTOP_MAC, "docker-host", EMPTY)).toThrow(/wrong daemon/);
  });
});

describe(`${REFUSE_DESKTOP_ENV}=1`, () => {
  test("refuses Desktop and says why", () => {
    const r = checkDaemon(DESKTOP_MAC, null, REFUSING);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.reason).toBe("docker-desktop");
    expect(r.error.message).toContain("Docker Desktop");
    expect(r.error.message).toContain(REFUSE_DESKTOP_ENV);
    expect(r.error.detail?.["name"]).toBe("docker-desktop");
  });

  test("refuses Desktop even when expectName names it", () => {
    expect(() => assertRemoteDaemon(DESKTOP_MAC, "docker-desktop", REFUSING)).toThrow(
      DockerGuardError,
    );
  });

  test("lets remote daemons through", () => {
    expect(assertRemoteDaemon(REMOTE_HOST, null, REFUSING)).toEqual({
      ok: true,
      name: "docker-host",
    });
    expect(checkDaemon({}, null, REFUSING).ok).toBe(true);
  });

  test("only the literal 1 turns it on", () => {
    for (const v of ["true", "yes", "0", "", "01", " 1"]) {
      expect(desktopRefused({ [REFUSE_DESKTOP_ENV]: v })).toBe(false);
    }
    expect(desktopRefused(REFUSING)).toBe(true);
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

  test("matching is exact, with no trimming or case folding", () => {
    expect(
      checkDaemon({ Name: "Docker-Host", OperatingSystem: "Ubuntu" }, "docker-host", EMPTY).ok,
    ).toBe(false);
    expect(
      checkDaemon({ Name: "docker-host ", OperatingSystem: "Ubuntu" }, "docker-host", EMPTY).ok,
    ).toBe(false);
  });
});

// DOCKER_HOST names docker-host, but DOCKER_CONTEXT=desktop-linux quietly wins.
describe("the actual accident", () => {
  test("expectName catches it with no env set", () => {
    const host = { id: "docker-host", expectName: "docker-host" };
    expect(() => assertHostDaemon(host, DESKTOP_MAC, EMPTY)).toThrow(/wrong daemon/);
  });

  test("with the env set, the desktop reason is reported first", () => {
    let err: DockerGuardError | undefined;
    try {
      assertHostDaemon({ id: "docker-host", expectName: "docker-host" }, DESKTOP_MAC, REFUSING);
    } catch (e) {
      err = e as DockerGuardError;
    }
    expect(err?.reason).toBe("docker-desktop");
    expect(err?.message).toContain("host docker-host");
    expect(err?.detail?.["hostId"]).toBe("docker-host");
  });

  test("guard errors carry an HTTP status, so they surface as problem+json", () => {
    const r = checkDaemon(DESKTOP_MAC, null, REFUSING);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.status).toBe(503);
    expect(r.error.toProblem()["detail"]).toContain("Docker Desktop");
  });

  test("a correctly configured docker-host host passes cleanly", () => {
    expect(
      assertHostDaemon({ id: "docker-host", expectName: "docker-host" }, REMOTE_HOST, REFUSING),
    ).toEqual({ ok: true, name: "docker-host" });
  });
});

describe("daemonEngine", () => {
  test("BuildahVersion means Podman", () => {
    expect(daemonEngine(PODMAN)).toBe("podman");
  });

  test.each([
    ["Docker Engine", REMOTE_HOST],
    ["Docker Desktop", DESKTOP_MAC],
    ["an empty BuildahVersion", { ...PODMAN, BuildahVersion: "" }],
    ["an empty payload", {}],
  ])("%s is docker", (_what, info) => {
    expect(daemonEngine(info)).toBe("docker");
  });
});

describe("describeDaemon", () => {
  test("one line, no credentials", () => {
    expect(describeDaemon(REMOTE_HOST)).toBe(
      "docker-host / Debian GNU/Linux 12 (bookworm) / docker 27.3.1 / x86_64",
    );
  });

  test("names Podman", () => {
    expect(describeDaemon(PODMAN)).toBe("podman-host / fedora / podman 5.2.2");
  });

  test("survives an empty payload", () => {
    expect(describeDaemon({})).toBe("? / ?");
  });
});
