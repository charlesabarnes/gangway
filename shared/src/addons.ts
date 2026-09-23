export const ADDON_IDS = ["postgres", "mysql", "redis"] as const;
export type AddonId = (typeof ADDON_IDS)[number];
export const isAddonId = (s: string): s is AddonId => (ADDON_IDS as readonly string[]).includes(s);

export type AddonChoice = { id: AddonId; version: string };

export type Addon = {
  id: AddonId;
  name: string;
  description: string;
  service: string;
  port: number;
  versions: Readonly<Record<string, string>>;
  defaultVersion: string;
  seedFiles: readonly string[];
  env: readonly string[];
  hints: { npm: readonly string[]; pip: readonly string[]; composer: readonly string[] };
};

export const ADDONS: readonly Addon[] = [
  {
    id: "postgres",
    name: "PostgreSQL",
    service: "postgres",
    port: 5432,
    description:
      "A fresh Postgres for this preview. DATABASE_URL points at it; seed.sql (or db/seed.sql) loads on its first start.",
    versions: {
      "18": "postgres:18-alpine",
      "17": "postgres:17-alpine",
      "16": "postgres:16-alpine",
    },
    defaultVersion: "18",
    seedFiles: ["seed.sql", "db/seed.sql"],
    env: ["DATABASE_URL", "POSTGRES_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"],
    // Drivers only: an ORM (Prisma, Django, Laravel) may as well mean SQLite.
    hints: {
      npm: ["pg", "postgres", "@neondatabase/serverless", "@vercel/postgres"],
      pip: ["psycopg", "psycopg2", "psycopg2-binary", "asyncpg"],
      composer: [],
    },
  },
  {
    id: "mysql",
    name: "MySQL",
    service: "mysql",
    port: 3306,
    description:
      "A fresh MySQL 8.4 for this preview. MYSQL_URL points at it; seed.sql (or db/seed.sql) loads on its first start. Slow to start the first time (~20s).",
    versions: { "8.4": "mysql:8.4" },
    defaultVersion: "8.4",
    seedFiles: ["seed.sql", "db/seed.sql"],
    env: [
      "MYSQL_URL",
      "MYSQL_HOST",
      "MYSQL_PORT",
      "MYSQL_USER",
      "MYSQL_PASSWORD",
      "MYSQL_DATABASE",
    ],
    hints: {
      npm: ["mysql", "mysql2"],
      pip: ["mysqlclient", "pymysql", "mysql-connector-python"],
      composer: [],
    },
  },
  {
    id: "redis",
    name: "Redis",
    service: "redis",
    port: 6379,
    description:
      "A Redis for this preview, append-only so it survives a sleep. REDIS_URL points at it.",
    versions: { "8": "redis:8-alpine" },
    defaultVersion: "8",
    seedFiles: [],
    env: ["REDIS_URL", "REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD"],
    hints: {
      npm: ["redis", "ioredis", "@redis/client", "bullmq", "bull"],
      pip: ["redis", "celery", "rq"],
      composer: ["predis/predis"],
    },
  },
];

export const addonById = (id: AddonId): Addon => ADDONS.find((a) => a.id === id)!;
export const isSql = (id: AddonId): boolean => id === "postgres" || id === "mysql";
