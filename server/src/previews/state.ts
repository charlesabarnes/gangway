import type { Preview, PreviewState } from "@gangway/shared/domain";
import type { PreviewsRepo } from "../db/repos/previews.ts";
import { AppError, notFound } from "../errors.ts";
import type { EventBus } from "../events/bus.ts";
import type { RouteTable } from "../routing/table.ts";

const LEGAL: Record<PreviewState, readonly PreviewState[]> = {
  building: ["starting", "failed", "destroying"],
  starting: ["awake", "asleep", "failed", "destroying"],
  awake: ["asleep", "starting", "failed", "destroying", "building"],
  asleep: ["starting", "failed", "destroying"],
  failed: ["building", "destroying"],
  destroying: ["destroyed", "failed"],
  destroyed: [],
};

export const canTransition = (from: PreviewState, to: PreviewState): boolean =>
  LEGAL[from].includes(to);

export class PreviewStates {
  readonly #previews: PreviewsRepo;
  readonly #table: RouteTable;
  readonly #bus: EventBus;

  constructor(previews: PreviewsRepo, table: RouteTable, bus: EventBus) {
    this.#previews = previews;
    this.#table = table;
    this.#bus = bus;
  }

  transition(id: string, to: PreviewState, error: string | null = null): Preview {
    const current = this.#previews.get(id);
    if (!current) throw notFound(`no such preview: ${id}`);
    if (!canTransition(current.state, to)) {
      throw new AppError("conflict", `preview is ${current.state}; cannot become ${to}`, {
        state: current.state,
      });
    }
    // No await between these three updates, so no request sees them disagree.
    this.#previews.setState(id, to, error);
    this.#table.setState(id, to);
    this.#bus.publish(
      "preview.state",
      { state: to, from: current.state, ...(error ? { error } : {}) },
      id,
    );
    return this.#previews.get(id)!;
  }
}
