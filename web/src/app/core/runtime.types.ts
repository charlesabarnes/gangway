// The runtimes gangway builds with and the add-on databases it can attach.
export type RuntimeId = 'static' | 'node' | 'bun' | 'deno' | 'workerd' | 'python' | 'php';
export const RUNTIME_IDS: readonly RuntimeId[] = [
  'static',
  'node',
  'bun',
  'deno',
  'workerd',
  'python',
  'php',
];
export type Detected = RuntimeId | 'own';

export type Runtime = {
  id: RuntimeId;
  name: string;
  language: string;
  description: string;
  image: string;
  port: number;
  starter: Record<string, string>;
  versions: string[];
};
export type DetectionRule = { runtime: Detected; markers: string[] };
export type RuntimeList = {
  runtimes: Runtime[];
  detection: DetectionRule[];
  planFiles: string[];
  addons: AddonInfo[];
};

export type AddonId = 'postgres' | 'mysql' | 'redis';
export const ADDON_IDS: readonly AddonId[] = ['postgres', 'mysql', 'redis'];
export type AddonChoice = { id: AddonId; version: string };
export type AddonInfo = {
  id: AddonId;
  name: string;
  description: string;
  versions: string[];
  defaultVersion: string;
  env: string[];
};
