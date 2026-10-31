import { expect, test } from "bun:test";
import type { ComposeResult } from "../../src/docker/compose.ts";
import { CPU_ABUSE, CpuWatch } from "../../src/previews/cpu-watch.ts";
import { setupPreviewContext } from "../helpers/preview-context.ts";

const ok = (stdout: string): ComposeResult => ({ code: 0, stdout, stderr: "", signal: null });

/** A context whose containers report `use` (CPU percent per container id). */
async function world(runtime: string | null) {
  const s = setupPreviewContext();
  const miner = await s.deployed("miner");
  const quiet = await s.deployed("quiet");
  s.db.run("UPDATE hosts SET runtime = $r", { r: runtime });
  const use = new Map([
    ["aaa111", "61.0%"],
    ["aaa222", "40.5%"],
    ["bbb111", "3.2%"],
  ]);
  const owners = { aaa111: miner.id, aaa222: miner.id, bbb111: quiet.id };
  const capture = s.ctx.compose.capture.bind(s.ctx.compose);
  s.ctx.compose = {
    ...s.ctx.compose,
    capture: async (argv, host, o) => {
      if (argv[1] === "ps" && argv.includes("--format")) {
        return ok(
          Object.entries(owners)
            .map(([c, p]) => `${c}000000 ${p}`)
            .join("\n"),
        );
      }
      if (argv[1] === "stats") {
        return ok([...use].map(([c, v]) => `${c} ${v}`).join("\n"));
      }
      return capture(argv, host, o);
    },
  };
  return { s, miner, quiet, use, watch: new CpuWatch(s.ctx) };
}

test("a preview that holds a core on a sandboxed host sleeps and is flagged", async () => {
  const { s, miner, quiet, watch } = await world("runsc");
  for (let i = 1; i < CPU_ABUSE.samples; i++) {
    expect(await watch.sample()).toEqual([]);
  }
  expect(await watch.sample()).toEqual([miner.id]);
  expect(s.previews.get(miner.id)!.state).toBe("asleep");
  expect(s.previews.get(quiet.id)!.state).toBe("awake");
  expect(s.ctx.logs.tail(miner.id).join("\n")).toContain("1.0 cores for 15 min straight");
  expect(s.audit.page({ limit: 5, action: "preview.cpu_abuse" }).entries).toHaveLength(1);
});

test("a quiet minute starts the count again", async () => {
  const { s, miner, use, watch } = await world("runsc");
  for (let i = 1; i < CPU_ABUSE.samples; i++) {
    await watch.sample();
  }
  use.set("aaa111", "1.0%");
  expect(await watch.sample()).toEqual([]);
  use.set("aaa111", "99.0%");
  for (let i = 1; i < CPU_ABUSE.samples; i++) {
    expect(await watch.sample()).toEqual([]);
  }
  expect(s.previews.get(miner.id)!.state).toBe("awake");
});

test("a host without the sandbox runtime is not watched", async () => {
  const { s, miner, watch } = await world(null);
  for (let i = 0; i < CPU_ABUSE.samples + 1; i++) {
    expect(await watch.sample()).toEqual([]);
  }
  expect(s.previews.get(miner.id)!.state).toBe("awake");
});

test("a stalled docker command gives way when the job is stopped", async () => {
  const { s, watch } = await world("runsc");
  s.ctx.compose = {
    ...s.ctx.compose,
    capture: (_argv, _host, o) =>
      new Promise((_, reject) => {
        o.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);
  expect(await watch.sample(stop.signal)).toEqual([]);
});
