import { describe, expect, test } from "bun:test";
import type { Host } from "@gangway/shared/domain";
import { noRoomForBuild, onThisMachine, type RoomProbes } from "../../src/previews/build-room.ts";

const MiB = 1024 ** 2;
const host = (dockerHost: string) => ({ dockerHost }) as Host;
const local = host("unix:///var/run/docker.sock");
const probes = (memory: number | null, disk: number | null): RoomProbes => ({
  memory: async () => memory,
  disk: async () => disk,
});
const needs = { memoryBytes: 512 * MiB, diskBytes: 2048 * MiB };

describe("noRoomForBuild", () => {
  test("enough of both is room", async () => {
    expect(await noRoomForBuild(local, "/state", needs, probes(4096 * MiB, 9000 * MiB))).toBeNull();
  });

  test("too little memory or disk is refused, naming the setting", async () => {
    expect(await noRoomForBuild(local, "/state", needs, probes(100 * MiB, 9000 * MiB))).toBe(
      "the host has 100 MiB of memory available; a build needs 512 MiB (previews.limits.buildMemory)",
    );
    expect(await noRoomForBuild(local, "/state", needs, probes(4096 * MiB, 10 * MiB))).toContain(
      "gangway's disk has 10 MiB free; a build needs 2048 MiB (previews.limits.buildDisk)",
    );
  });

  test("memory is only checked when the build runs on this machine", async () => {
    const remote = host("ssh://builder@10.0.0.9");
    expect(await noRoomForBuild(remote, "/state", needs, probes(1, 9000 * MiB))).toBeNull();
  });

  test("a socket or a loopback address is this machine; anything else may not be", () => {
    for (const h of [
      "unix:///var/run/docker.sock",
      "tcp://127.0.0.1:2375",
      "tcp://localhost:2376",
      "tcp://[::1]:2375",
    ]) {
      expect(onThisMachine(h)).toBe(true);
    }
    for (const h of [
      "tcp://10.0.0.9:2375",
      "ssh://builder@10.0.0.9",
      "tcp://127.0.0.1.evil.example:2375",
    ]) {
      expect(onThisMachine(h)).toBe(false);
    }
  });

  test("0 turns a check off, and an unreadable reading never refuses", async () => {
    const off = { memoryBytes: 0, diskBytes: 0 };
    expect(await noRoomForBuild(local, "/state", off, probes(1, 1))).toBeNull();
    expect(await noRoomForBuild(local, "/state", needs, probes(null, null))).toBeNull();
  });
});
