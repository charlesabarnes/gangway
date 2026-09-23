import type { Route } from "@gangway/shared/domain";

export type PlannedRoute = Omit<Route, "createdAt">;
