import { describe, expect, test } from "bun:test";
import { EgressGuard, egressRuleset } from "../../src/hosts/egress.ts";

const host = (egress: "open" | "restricted") => ({
  id: "pool-1",
  dockerHost: "ssh://gangway@10.0.0.5",
  egress,
});

function guard(exit = 0) {
  const calls: { argv: string[]; dockerHost: string }[] = [];
  const state = { exit };
  const g = new EgressGuard({
    image: () => "ghcr.io/charlesabarnes/gangway:0.6.0",
    run: async (argv, dockerHost) => {
      calls.push({ argv, dockerHost });
      const code = state.exit;
      return { code, stdout: "", stderr: code === 0 ? "" : "nft: permission denied", signal: null };
    },
  });
  return { g, calls, state };
}

describe("egress rules", () => {
  test("drop private, metadata and mail traffic leaving the bridges, and the host itself", () => {
    const rules = egressRuleset();
    expect(rules).toStartWith("table inet gangway_egress\ndelete table inet gangway_egress\n");
    for (const range of ["10.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "100.64.0.0/10"]) {
      expect(rules).toContain(range);
    }
    expect(rules).toContain('iifname { "docker0", "br-*" } oifname { "docker0", "br-*" } accept');
    expect(rules).toContain("tcp dport { 25, 465, 587, 2525 } drop");
    const dns = rules.indexOf(
      'iifname { "docker0", "br-*" } meta l4proto { udp, tcp } th dport 53 accept',
    );
    expect(dns).toBeGreaterThan(0);
    expect(dns).toBeLessThan(rules.indexOf("@blocked4 drop"));
    expect(dns).toBeLessThan(rules.indexOf("@blocked6 drop"));
    expect(rules).toContain('iifname { "docker0", "br-*" } drop');
  });

  test("a preview never reaches another bridge through a published port", () => {
    const rules = egressRuleset();
    const both = 'iifname { "docker0", "br-*" } oifname { "docker0", "br-*" }';
    const dnat = rules.indexOf(`${both} ct status dnat drop`);
    expect(dnat).toBeGreaterThan(0);
    expect(dnat).toBeLessThan(rules.indexOf(`${both} accept`));
  });

  test("cap each container's outbound traffic once DNS and the drops are done", () => {
    const rules = egressRuleset();
    const cap = rules.indexOf("update @rate4 { ip saddr limit rate over 10 mbytes/second");
    expect(cap).toBeGreaterThan(rules.indexOf("@blocked4 drop"));
    expect(cap).toBeGreaterThan(rules.indexOf("th dport 53 accept"));
    expect(rules).toContain("update @rate6 { ip6 saddr limit rate over 10 mbytes/second");
  });

  test("are applied from a short-lived container in the host's network namespace", async () => {
    const { g, calls } = guard();
    await g.apply(host("restricted"));
    const [{ argv, dockerHost }] = calls as [{ argv: string[]; dockerHost: string }];
    expect(dockerHost).toBe("ssh://gangway@10.0.0.5");
    expect(argv.slice(0, 4)).toEqual(["docker", "run", "--rm", "--network"]);
    expect(argv).toContain("NET_ADMIN");
    expect(argv[argv.indexOf("--runtime") + 1]).toBe("runc");
    expect(argv[argv.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(argv).toContain("ghcr.io/charlesabarnes/gangway:0.6.0");
    expect(argv.find((a) => a.startsWith("GW_RULES="))).toBe(`GW_RULES=${egressRuleset()}`);
  });

  test("ensure applies once until forgotten; apply always runs again", async () => {
    const { g, calls } = guard();
    await g.ensure(host("restricted"));
    await g.ensure(host("restricted"));
    expect(calls).toHaveLength(1);
    g.forget("pool-1");
    await g.ensure(host("restricted"));
    await g.apply(host("restricted"));
    expect(calls).toHaveLength(3);
  });

  test("a host switched to open has the table taken off, once", async () => {
    const { g, calls } = guard();
    await g.apply(host("restricted"));
    await g.apply(host("open"));
    await g.apply(host("open"));
    expect(calls).toHaveLength(2);
    const rules = calls[1]!.argv.find((a) => a.startsWith("GW_RULES="));
    expect(rules).toBe("GW_RULES=table inet gangway_egress\ndelete table inet gangway_egress\n");
  });

  test("a removal that fails is tried again on the next pass, after the scan forgets", async () => {
    const { g, calls, state } = guard();
    await g.apply(host("restricted"));
    state.exit = 1;
    await expect(g.apply(host("open"))).rejects.toMatchObject({ reason: "egress-unapplied" });
    g.forget("pool-1");
    state.exit = 0;
    await g.apply(host("open"));
    await g.apply(host("open"));
    expect(calls).toHaveLength(3);
  });

  test("an open host is left alone", async () => {
    const { g, calls } = guard();
    await g.ensure(host("open"));
    await g.apply(host("open"));
    expect(calls).toHaveLength(0);
  });

  test("rules that cannot be applied refuse the host, and ensure tries again next time", async () => {
    const { g, calls } = guard(1);
    await expect(g.ensure(host("restricted"))).rejects.toMatchObject({
      reason: "egress-unapplied",
      message: expect.stringContaining("permission denied"),
    });
    await expect(g.ensure(host("restricted"))).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
});
