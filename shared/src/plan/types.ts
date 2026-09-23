import type { Command, FileIssue } from "../gangway-file.ts";
import type { AddonChoice, AddonId } from "../addons.ts";
import type { Detected, RuntimeId } from "../runtimes.ts";

export type PlanChoice = RuntimeId | "auto" | "own";

export type PlanInput = {
  paths: readonly string[];
  files: Readonly<Partial<Record<string, string>>>;
  runtime?: PlanChoice | undefined;
  previous?: Detected | undefined;
  addons?: readonly AddonRequest[] | undefined;
  previousAddons?: readonly AddonChoice[] | undefined;
};

export type AddonRequest = AddonId | { id: AddonId; version?: string | undefined };

export type Reason = { level: "info" | "warn" | "error"; found: string; then: string };

export type AppPlan = {
  kind: "own" | "runtime";
  runtime: RuntimeId | null;
  version: string | null;
  image: string | null;
  root: string;
  install: Command | null;
  build: Command | null;
  start: Command | null;
  release: Command | null;
  serve:
    | { kind: "server" }
    | { kind: "static"; output: string | null | false; fallback: "spa" | "404" | "listing" };
  docroot: string;
  entry: string | null;
  port: number | null;
  health: string | null;
  env: Record<string, string>;
  stack: {
    ttl?: string;
    visibility?: "public" | "unlisted" | "private";
    idle?: string;
    seed?: string;
  };
  configFile: string | null;
  addons: AddonChoice[];
  suggested: { id: AddonId; because: string }[];
  sqlSeed: string | null;
  reasons: Reason[];
  issues: FileIssue[];
};

export type ReadFile = (name: string) => string | undefined;
