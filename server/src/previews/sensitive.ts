// Files an upload may carry by accident that must never reach a visitor: env files, keys, credentials.
const DIRS = new Set([".aws", ".ssh", ".gnupg", ".svn", ".hg"]);
const FILES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".htpasswd",
  ".DS_Store",
]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const KEY = /\.(?:pem|key|p12|pfx)$/i;
const SSH_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/;

export function sensitiveName(name: string, isDir: boolean): boolean {
  if (isDir) {
    return DIRS.has(name);
  }
  if (FILES.has(name) || KEY.test(name) || SSH_KEY.test(name)) {
    return true;
  }
  return (name === ".env" || name.startsWith(".env.")) && !ENV_TEMPLATES.has(name);
}

// env files and .npmrc stay in a build's context: a framework or a private registry may need them.
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
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
];

export const NGINX_DENY =
  "location ~ /\\.(?!well-known/) { return 404; }\n  " +
  "location ~* \\.(?:pem|key|p12|pfx)$ { return 404; }\n  " +
  "location ~ /id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-]) { return 404; }\n  ";
