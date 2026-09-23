import type { RenderedAddons } from "./addons.ts";

// Compose interpolates $ in every file it reads, so $$ is a literal.
export const literal = (env: Record<string, string> = {}) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace(/\$/g, "$$$$")]));

type Generated = {
  port: number;
  env?: Record<string, string> | undefined;
  stack?: Record<string, string> | undefined;
  health?: string | null | undefined;
  sidecars?: Pick<RenderedAddons, "services" | "volumes" | "dependsOn"> | undefined;
};

const generated = (o: Generated, web: Record<string, unknown>): string =>
  `${JSON.stringify(
    {
      ...(o.stack && Object.keys(o.stack).length ? { "x-gangway": o.stack } : {}),
      services: {
        web: {
          ...web,
          "x-gangway": { expose: true, port: o.port, ...(o.health ? { health: o.health } : {}) },
          ...(o.env && Object.keys(o.env).length ? { environment: literal(o.env) } : {}),
          ...(o.sidecars && Object.keys(o.sidecars.dependsOn).length
            ? { depends_on: o.sidecars.dependsOn }
            : {}),
          restart: "unless-stopped",
        },
        ...(o.sidecars?.services ?? {}),
      },
      ...(o.sidecars && Object.keys(o.sidecars.volumes).length
        ? { volumes: o.sidecars.volumes }
        : {}),
    },
    null,
    2,
  )}\n`;

export function composeForDockerfile(o: Generated): string {
  return generated(o, { build: { context: "." } });
}

export function composeForImage(o: {
  image: string;
  port: number;
  env?: Record<string, string> | undefined;
}): string {
  return generated(o, { image: o.image });
}

export function composeForRuntime(o: Generated & { context?: string }): string {
  return generated(o, {
    build: { context: o.context ?? ".", dockerfile: ".gangway/Dockerfile" },
    init: true,
  });
}
