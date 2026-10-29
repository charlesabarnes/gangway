import type { Host } from "@gangway/shared/domain";
import { composeCapture, composeEnv, type ComposeResult } from "../docker/compose.ts";
import { DockerGuardError } from "../docker/guard.ts";

export const EGRESS_TABLE = "gangway_egress";

const BRIDGES = '{ "docker0", "br-*" }';

const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
];
const BLOCKED_V6 = ["::1/128", "fc00::/7", "fe80::/10", "ff00::/8"];
const MAIL_PORTS = "{ 25, 465, 587, 2525 }";

/** Its own table, replaced whole: leaving the bridges for a private address, the host or mail drops. */
export function egressRuleset(): string {
  return `table inet ${EGRESS_TABLE}
delete table inet ${EGRESS_TABLE}
table inet ${EGRESS_TABLE} {
  set blocked4 { type ipv4_addr; flags interval; elements = { ${BLOCKED_V4.join(", ")} } }
  set blocked6 { type ipv6_addr; flags interval; elements = { ${BLOCKED_V6.join(", ")} } }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname ${BRIDGES} oifname ${BRIDGES} accept
    iifname ${BRIDGES} ip daddr @blocked4 drop
    iifname ${BRIDGES} ip6 daddr @blocked6 drop
    iifname ${BRIDGES} tcp dport ${MAIL_PORTS} drop
  }
  chain input {
    type filter hook input priority -10; policy accept;
    iifname ${BRIDGES} ct state established,related accept
    iifname ${BRIDGES} drop
  }
}
`;
}

type Target = Pick<Host, "id" | "dockerHost" | "egress">;
type Run = (argv: string[], dockerHost: string) => Promise<ComposeResult>;

const run: Run = (argv, dockerHost) =>
  composeCapture(argv, { dockerHost, env: composeEnv({ dockerHost }) });

/** Keeps the table on restricted hosts from a short-lived container in the host's network. */
export class EgressGuard {
  readonly #applied = new Set<string>();
  readonly #image: () => string;
  readonly #docker: string;
  readonly #run: Run;

  constructor(o: { image: () => string; docker?: string; run?: Run }) {
    this.#image = o.image;
    this.#docker = o.docker ?? "docker";
    this.#run = o.run ?? run;
  }

  async ensure(host: Target): Promise<void> {
    if (host.egress === "restricted" && !this.#applied.has(host.id)) {
      await this.apply(host);
    }
  }

  /** Every reconcile: a reboot drops them with the rest of nftables. */
  async apply(host: Target): Promise<void> {
    this.#applied.delete(host.id);
    if (host.egress !== "restricted") {
      return;
    }
    const r = await this.#run(
      [
        this.#docker,
        "run",
        "--rm",
        "--network",
        "host",
        "--runtime",
        "runc",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--security-opt",
        "no-new-privileges",
        "--env",
        `GW_RULES=${egressRuleset()}`,
        "--entrypoint",
        "sh",
        this.#image(),
        "-c",
        'printf "%s" "$GW_RULES" | nft -f -',
      ],
      host.dockerHost,
    );
    if (r.code !== 0) {
      throw new DockerGuardError(
        "egress-unapplied",
        `host ${host.id}: could not apply the egress rules (exit ${r.code}): ${r.stderr.trim().slice(-300)}`,
        { hostId: host.id },
      );
    }
    this.#applied.add(host.id);
  }

  forget(hostId: string): void {
    this.#applied.delete(hostId);
  }
}
