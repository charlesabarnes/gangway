import { describe, expect, test } from "bun:test";
import type { AcmeProvider } from "../../src/tls/acme.ts";
import { CertManager } from "../../src/tls/certs.ts";
import { CertStore } from "../../src/tls/certstore.ts";
import { createCa, issueLeaf, type DevCa } from "../../src/tls/selfsigned.ts";
import type { CertBundle, CertUnit } from "../../src/tls/types.ts";
import { silentLogger } from "../helpers/logger.ts";

const HOUR = 3_600_000;
const CONTROL: CertUnit = { names: ["*.gw.test", "gw.test"] };
const CLAIMED: CertUnit = { names: ["*.client.test", "client.test"], delegate: "c1.acme.gw.test" };
const EXACT: CertUnit = { names: ["www.shop.test"], delegate: "c2.acme.gw.test" };

async function devCa(): Promise<() => Promise<DevCa>> {
  const ca = await createCa("dev");
  return async () => ca;
}

/** An ACME provider that issues from its own CA, or fails for the names it is told to. */
async function fakeAcme(o: { stored?: string[][]; failFor?: Set<string> } = {}) {
  const ca = await createCa("Fake ACME CA");
  const orders: { names: string[]; delegate: string | undefined }[] = [];
  const stored = new Map<string, CertBundle>();
  for (const names of o.stored ?? [])
    stored.set(names[0]!, { materials: [await issueLeaf(ca, names, 90)] });
  const acme = {
    load: (names: string[]) => stored.get(names[0]!) ?? null,
    isDue: () => false,
    async ensure(names: string[], _signal?: AbortSignal, x: { delegate?: string } = {}) {
      orders.push({ names, delegate: x.delegate });
      if (o.failFor?.has(names[0]!)) throw new Error(`no ${names[0]}`);
      const bundle = { materials: [await issueLeaf(ca, names, 90)] };
      stored.set(names[0]!, bundle);
      return bundle;
    },
  } as unknown as AcmeProvider;
  return { acme, orders };
}

describe("serving by SNI", () => {
  test("each certificate answers under every one of its names, the first as default", async () => {
    const ca = await createCa();
    const store = new CertStore({
      materials: [await issueLeaf(ca, CONTROL.names), await issueLeaf(ca, EXACT.names)],
    });
    expect(store.tlsConfig().map((e) => e.serverName)).toEqual([
      "*.gw.test",
      "gw.test",
      "www.shop.test",
    ]);
  });
});

describe("the certificate manager", () => {
  test("selfsigned: a leaf per unit, following the plan as it grows and shrinks", async () => {
    let plan = [CONTROL];
    const m = new CertManager({
      mode: "selfsigned",
      plan: () => plan,
      devCa: await devCa(),
      logger: silentLogger(),
    });
    expect((await m.start()).materials.map((x) => x.names)).toEqual([CONTROL.names]);
    expect(await m.refresh()).toBeNull();
    plan = [CONTROL, EXACT];
    expect((await m.refresh())!.materials.map((x) => x.names)).toEqual([
      CONTROL.names,
      EXACT.names,
    ]);
    plan = [CONTROL];
    expect((await m.refresh())!.materials).toHaveLength(1);
  });

  test("acme: stored ones serve at boot, the rest stand in until ordered", async () => {
    const { acme, orders } = await fakeAcme({ stored: [CONTROL.names] });
    const m = new CertManager({
      mode: "acme",
      plan: () => [CONTROL, CLAIMED],
      devCa: await devCa(),
      acme,
      logger: silentLogger(),
    });
    const boot = await m.start();
    expect(boot.materials.map((x) => x.issuer)).toEqual(["CN=Fake ACME CA", "CN=dev"]);
    expect(m.status().map((x) => x.issued)).toEqual([true, false]);
    const next = await m.refresh();
    expect(orders).toEqual([{ names: CLAIMED.names, delegate: "c1.acme.gw.test" }]);
    expect(next!.materials.map((x) => x.issuer)).toEqual(["CN=Fake ACME CA", "CN=Fake ACME CA"]);
    expect(await m.refresh()).toBeNull();
  });

  test("acme: one failing domain backs off alone, doubling up to a day", async () => {
    const clock = { now: 0 };
    const { acme, orders } = await fakeAcme({ failFor: new Set([CLAIMED.names[0]!]) });
    const m = new CertManager({
      mode: "acme",
      plan: () => [CONTROL, CLAIMED, EXACT],
      devCa: await devCa(),
      acme,
      logger: silentLogger(),
      now: () => clock.now,
    });
    await m.start();
    await m.refresh();
    expect(orders.map((o) => o.names[0])).toEqual(["*.gw.test", "*.client.test", "www.shop.test"]);
    expect(m.status()[1]).toMatchObject({ issued: false, lastError: "no *.client.test" });

    orders.length = 0;
    clock.now = HOUR - 1;
    await m.refresh();
    expect(orders).toEqual([]);
    clock.now = HOUR;
    await m.refresh();
    expect(orders.map((o) => o.names[0])).toEqual(["*.client.test"]);
    orders.length = 0;
    clock.now = HOUR + 2 * HOUR - 1;
    await m.refresh();
    expect(orders).toEqual([]);
  });

  test("acme: at most a handful of new orders a run", async () => {
    const units = Array.from({ length: 8 }, (_, i) => ({ names: [`h${i}.test`] }));
    const { acme, orders } = await fakeAcme();
    const m = new CertManager({
      mode: "acme",
      plan: () => [CONTROL, ...units],
      devCa: await devCa(),
      acme,
      logger: silentLogger(),
      maxOrdersPerRun: 3,
    });
    await m.start();
    await m.refresh();
    expect(orders).toHaveLength(3);
    await m.refresh();
    expect(orders).toHaveLength(6);
  });
});
