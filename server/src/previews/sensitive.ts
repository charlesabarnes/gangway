/**
 * Files an upload may carry by accident that must never reach a visitor: env files, keys and
 * credentials. gangway leaves them out of a site it serves, and nginx refuses them in a static
 * container. A preview's secrets belong in gangway's secrets, not in its files.
 */

/** Directories left out whole. */
const DIRS = new Set([".aws", ".ssh", ".gnupg", ".svn", ".hg"]);

/** Files left out by exact name. */
const FILES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".htpasswd",
  ".DS_Store",
]);

/** env files meant to be shared, as templates with no real values in them. */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

const KEY = /\.(?:pem|key|p12|pfx)$/i;
const SSH_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/;

/** True for a file or directory name gangway never serves. */
export function sensitiveName(name: string, isDir: boolean): boolean {
  if (isDir) {
    return DIRS.has(name);
  }
  if (FILES.has(name) || KEY.test(name) || SSH_KEY.test(name)) {
    return true;
  }
  return (name === ".env" || name.startsWith(".env.")) && !ENV_TEMPLATES.has(name);
}

/**
 * Credentials a container build has no use for, left out of its context so no image layer
 * holds them. env files and .npmrc stay in: a build may read them (a framework's public env, a
 * private registry), and an app container does not serve its own files.
 */
export const DOCKERIGNORE_CREDENTIALS = [
  "**/.aws",
  "**/.ssh",
  "**/.gnupg",
  "**/.netrc",
  "**/.pypirc",
  "**/.git-credentials",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
];

/** nginx locations that refuse what a static container must not serve, before try_files. */
export const NGINX_DENY =
  "location ~ /\\.(?!well-known/) { return 404; }\n  " +
  "location ~* \\.(?:pem|key|p12|pfx)$ { return 404; }\n  " +
  "location ~ /id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-]) { return 404; }\n  ";
