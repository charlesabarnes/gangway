import {
  siBun,
  siCloudflareworkers,
  siDeno,
  siDocker,
  siHtml5,
  siMysql,
  siNodedotjs,
  siPhp,
  siPostgresql,
  siPython,
  siRedis,
} from 'simple-icons';
import type { AddonId, Detected } from '../../core/api.types';

export type Look = { path: string; color: string | null; tagline: string; name: string };

export const OWN_LABEL = 'Own Dockerfile / compose';

const hex = (h: string) => (h === '000000' ? null : `#${h}`);

export const RUNTIME_LOOKS: Record<Detected, Look> = {
  static: {
    name: 'Static',
    path: siHtml5.path,
    color: hex(siHtml5.hex),
    tagline: 'Plain files, served by nginx',
  },
  node: {
    name: 'Node.js',
    path: siNodedotjs.path,
    color: hex(siNodedotjs.hex),
    tagline: 'npm start, or a static build',
  },
  bun: {
    name: 'Bun',
    path: siBun.path,
    color: hex(siBun.hex),
    tagline: 'TypeScript, no build step',
  },
  deno: {
    name: 'Deno',
    path: siDeno.path,
    color: hex(siDeno.hex),
    tagline: 'TypeScript, deps cached at build',
  },
  workerd: {
    name: 'Workers',
    path: siCloudflareworkers.path,
    color: hex(siCloudflareworkers.hex),
    tagline: "Cloudflare's Workers runtime",
  },
  python: {
    name: 'Python',
    path: siPython.path,
    color: hex(siPython.hex),
    tagline: 'Flask, FastAPI, Django…',
  },
  php: {
    name: 'PHP',
    path: siPhp.path,
    color: hex(siPhp.hex),
    tagline: 'Apache + mod_php, Composer',
  },
  own: {
    name: 'Own Dockerfile',
    path: siDocker.path,
    color: hex(siDocker.hex),
    tagline: 'Your own Dockerfile or compose file',
  },
};

export const ADDON_LOOKS: Record<AddonId, Look> = {
  postgres: {
    name: 'PostgreSQL',
    path: siPostgresql.path,
    color: hex(siPostgresql.hex),
    tagline: 'DATABASE_URL',
  },
  mysql: { name: 'MySQL', path: siMysql.path, color: hex(siMysql.hex), tagline: 'MYSQL_URL' },
  redis: { name: 'Redis', path: siRedis.path, color: hex(siRedis.hex), tagline: 'REDIS_URL' },
};

export const tint = (color: string | null, pct = 16): string =>
  color
    ? `color-mix(in oklch, ${color} ${pct}%, transparent)`
    : `color-mix(in oklch, currentColor ${pct - 6}%, transparent)`;
