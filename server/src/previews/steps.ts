import type { Host } from "@gangway/shared/domain";
import { unprocessable } from "../errors.ts";
import type { ComposeModel } from "./compose-model.ts";
import type { PlannedRoute } from "./compose-routes.ts";
import type { PreviewContext } from "./context.ts";

export class StepFailed extends Error {
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null = null) {
    super(message);
    this.exitCode = exitCode;
  }
}

export type Step = (
  what: string,
  argv: string[],
  stream: "build" | "seed" | "stdout",
  env?: Record<string, string>,
) => Promise<void>;

export function stepper(
  ctx: PreviewContext,
  o: { previewId: string; host: Host; cwd: string; signal: AbortSignal },
): Step {
  return async (what, argv, stream, env) => {
    ctx.logs.append(o.previewId, "system", `$ compose ${what}`);
    for await (const ev of ctx.compose.stream(argv, o.host, {
      cwd: o.cwd,
      signal: o.signal,
      ...(env ? { env } : {}),
    })) {
      if (ev.type === "line")
        ctx.logs.append(
          o.previewId,
          ev.stream === "stderr" && stream === "stdout" ? "stderr" : stream,
          ev.line,
        );
      else if (ev.code !== 0)
        throw new StepFailed(
          `compose ${what} exited ${ev.code}${ev.signal ? ` (${ev.signal})` : ""}`,
          ev.code,
        );
    }
    o.signal.throwIfAborted();
  };
}

export type Job = { service: string; command: string };

export function seedFor(model: ComposeModel, routes: PlannedRoute[]): Job | null {
  const seed = model.x.seed;
  if (seed === undefined) return null;
  if (typeof seed !== "string") return seed;
  const primary = routes.find((r) => r.primary) ?? routes[0];
  if (!primary)
    throw unprocessable("x-gangway.seed names no service and nothing is exposed to run it in");
  return { service: primary.service, command: seed };
}

export function releaseFor(model: ComposeModel, routes: PlannedRoute[]): Job | null {
  const command = model.x.release;
  if (command === undefined) return null;
  const primary = routes.find((r) => r.primary) ?? routes[0];
  if (!primary) throw unprocessable("x-gangway.release needs an exposed service to run in");
  return { service: primary.service, command };
}

export const healthOf = (model: ComposeModel): Record<string, string> =>
  Object.fromEntries(model.services.flatMap((s) => (s.x.health ? [[s.name, s.x.health]] : [])));
