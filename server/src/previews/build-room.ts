import { readFile, statfs } from "node:fs/promises";
import type { Host } from "@gangway/shared/domain";

/** The least a build needs free when it starts; 0 skips that check. */
export type BuildNeeds = { memoryBytes: number; diskBytes: number };

export type RoomProbes = {
  memory: () => Promise<number | null>;
  disk: (dir: string) => Promise<number | null>;
};

// The host's, not this container's: /proc/meminfo is the kernel's, shared with every container.
async function availableMemory(): Promise<number | null> {
  const info = await readFile("/proc/meminfo", "utf8").catch(() => null);
  const kb = info ? /^MemAvailable:\s+(\d+) kB$/m.exec(info)?.[1] : undefined;
  return kb === undefined ? null : Number(kb) * 1024;
}

async function freeDisk(dir: string): Promise<number | null> {
  const s = await statfs(dir).catch(() => null);
  return s ? s.bavail * s.bsize : null;
}

export const HOST_PROBES: RoomProbes = { memory: availableMemory, disk: freeDisk };

const mib = (n: number) => `${Math.floor(n / 1024 ** 2)} MiB`;

/**
 * Why a build may not start now, or null. Memory is checked only when the build runs on this
 * machine; the disk is gangway's state directory, where every upload is unpacked.
 */
export async function noRoomForBuild(
  host: Host,
  stateDir: string,
  needs: BuildNeeds,
  probes: RoomProbes = HOST_PROBES,
): Promise<string | null> {
  if (needs.memoryBytes > 0 && host.dockerHost.startsWith("unix://")) {
    const free = await probes.memory();
    if (free !== null && free < needs.memoryBytes) {
      return `the host has ${mib(free)} of memory available; a build needs ${mib(needs.memoryBytes)} (previews.limits.buildMemory)`;
    }
  }
  if (needs.diskBytes > 0) {
    const free = await probes.disk(stateDir);
    if (free !== null && free < needs.diskBytes) {
      return `gangway's disk has ${mib(free)} free; a build needs ${mib(needs.diskBytes)} (previews.limits.buildDisk)`;
    }
  }
  return null;
}
