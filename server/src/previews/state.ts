/**
 * The preview state machine. ONE function changes a preview's state, and it changes all
 * three copies together: the SQLite row (truth), the route table entries (what the proxy
 * reads per request) and the event stream (what the UI reads). Anything that set one
 * without the others would show up as a preview the UI calls awake and the proxy calls
 * building.
 */
import type { Preview, PreviewState } from "../../../shared/src/domain.ts";
import type { PreviewsRepo } from "../db/repos/previews.ts";
import { AppError, notFound } from "../errors.ts";
import type { EventBus } from "../events/bus.ts";
import type { RouteTable } from "../routing/table.ts";

const LEGAL: Record<PreviewState, readonly PreviewState[]> = {
  building: ["starting", "failed", "destroying"],
  // starting -> asleep: a WAKE that did not get there (ADR-0012). The containers are as they
  // were; the next request tries again. A deploy never takes this edge.
  starting: ["awake", "asleep", "failed", "destroying"],
  awake: ["asleep", "failed", "destroying", "building"],
  asleep: ["starting", "failed", "destroying"],
  failed: ["building", "destroying"],
  // A teardown that could not reach the daemon is a failure, not a success: the
  // containers are still there, so the routes and their ports stay claimed.
  destroying: ["destroyed", "failed"],
  destroyed: [],
};

export const canTransition = (from: PreviewState, to: PreviewState): boolean => LEGAL[from].includes(to);

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
      throw new AppError("conflict", `preview is ${current.state}; cannot become ${to}`, { state: current.state });
    }
    // Synchronous, no await between the three: no request can observe them disagreeing.
    this.#previews.setState(id, to, error);
    this.#table.setState(id, to);
    this.#bus.publish("preview.state", { state: to, from: current.state, ...(error ? { error } : {}) }, id);
    return this.#previews.get(id)!;
  }
}
