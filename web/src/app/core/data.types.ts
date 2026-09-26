import type { AddonChoice } from './api.types';

// The data browser's wire types, for a preview's add-on databases.
export type PreviewAddon = AddonChoice & { name: string; service: string; env: string[] };
export type DataTable = { schema: string; name: string };
export type DataResult = {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  message: string | null;
  ms: number;
};
export type RedisKeys = { cursor: string; keys: string[] };
export type RedisKey = { type: string; ttl: string; value: DataResult };
