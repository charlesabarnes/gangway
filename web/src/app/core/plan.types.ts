import type { ArtifactMeta } from './artifact.types';
import type { AddonChoice, AddonId, Detected, RuntimeId, Visibility } from './api.types';

export type Command = string | string[];
export type PlanReason = { level: 'info' | 'warn' | 'error'; found: string; then: string };
export type PlanIssue = { path: string; message: string };
export type AppPlan = {
  kind: 'own' | 'runtime';
  runtime: RuntimeId | null;
  version: string | null;
  image: string | null;
  root: string;
  install: Command | null;
  build: Command | null;
  start: Command | null;
  release: Command | null;
  serve:
    | { kind: 'server' }
    | { kind: 'static'; output: string | null | false; fallback: 'spa' | '404' | 'listing' };
  docroot: string;
  entry: string | null;
  port: number | null;
  health: string | null;
  env: Record<string, string>;
  stack: { ttl?: string; visibility?: Visibility; idle?: string; seed?: string };
  configFile: string | null;
  addons: AddonChoice[];
  suggested: { id: AddonId; because: string }[];
  sqlSeed: string | null;
  artifact?: ArtifactMeta | null;
  reasons: PlanReason[];
  issues: PlanIssue[];
};
export type PlanRequest = {
  paths: string[];
  files: Record<string, string>;
  runtime?: Detected | 'auto';
  addons?: AddonId[];
};
