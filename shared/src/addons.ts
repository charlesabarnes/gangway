/**
 * Add-ons (ADR-0017): a throwaway database next to a preview. NOT an app from spec §12's
 * catalogue -- nothing is installed, nothing outlives anything. An add-on is a pinned
 * sidecar in ONE preview's compose project: no URL, no published port, its data in a
 * volume that `down -v` removes with the preview. It survives saves, rebuilds and
 * idle-sleep; it does not survive destroy.
 *
 * Adding one is a catalogue entry here plus its service in server/src/previews/addons.ts,
 * like a runtime.
 */

export const ADDON_IDS = ["postgres", "mysql", "redis"] as const;
export type AddonId = (typeof ADDON_IDS)[number];
export const isAddonId = (s: string): s is AddonId => (ADDON_IDS as readonly string[]).includes(s);

/** What a preview runs: the add-on at a MAJOR version, recorded so an upgrade of gangway never changes it. */
export type AddonChoice = { id: AddonId; version: string };

export type Addon = {
  id: AddonId;
  name: string;
  description: string;
  /** The compose service, and so the hostname the app connects to. */
  service: string;
  port: number;
  /** Major -> pinned image. `defaultVersion` is what a new preview gets. */
  versions: Readonly<Record<string, string>>;
  defaultVersion: string;
  /** SQL add-ons load the first of these on their FIRST start only (a fresh volume). */
  seedFiles: readonly string[];
  /** The variables the app receives. */
  env: readonly string[];
  /** What in an upload suggests it: DRIVER names by ecosystem (a suggestion is pre-ticked in the UI). */
  hints: { npm: readonly string[]; pip: readonly string[]; composer: readonly string[] };
};

export const ADDONS: readonly Addon[] = [
  {
    id: "postgres", name: "PostgreSQL", service: "postgres", port: 5432,
    description: "A fresh Postgres for this preview. DATABASE_URL points at it; seed.sql (or db/seed.sql) loads on its first start.",
    versions: { "18": "postgres:18-alpine", "17": "postgres:17-alpine", "16": "postgres:16-alpine" }, defaultVersion: "18",
    seedFiles: ["seed.sql", "db/seed.sql"],
    env: ["DATABASE_URL", "POSTGRES_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"],
    // Drivers only: an ORM (Prisma, Django, Laravel) may as well mean SQLite.
    hints: { npm: ["pg", "postgres", "@neondatabase/serverless", "@vercel/postgres"], pip: ["psycopg", "psycopg2", "psycopg2-binary", "asyncpg"], composer: [] },
  },
  {
    id: "mysql", name: "MySQL", service: "mysql", port: 3306,
    description: "A fresh MySQL 8.4 for this preview. MYSQL_URL points at it; seed.sql (or db/seed.sql) loads on its first start. Slow to start the first time (~20s).",
    versions: { "8.4": "mysql:8.4" }, defaultVersion: "8.4",
    seedFiles: ["seed.sql", "db/seed.sql"],
    env: ["MYSQL_URL", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"],
    hints: { npm: ["mysql", "mysql2"], pip: ["mysqlclient", "pymysql", "mysql-connector-python"], composer: [] },
  },
  {
    id: "redis", name: "Redis", service: "redis", port: 6379,
    description: "A Redis for this preview, append-only so it survives a sleep. REDIS_URL points at it.",
    versions: { "8": "redis:8-alpine" }, defaultVersion: "8",
    seedFiles: [],
    env: ["REDIS_URL", "REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD"],
    hints: { npm: ["redis", "ioredis", "@redis/client", "bullmq", "bull"], pip: ["redis", "celery", "rq"], composer: ["predis/predis"] },
  },
];

export const addonById = (id: AddonId): Addon => ADDONS.find((a) => a.id === id)!;
export const isSql = (id: AddonId): boolean => id === "postgres" || id === "mysql";
