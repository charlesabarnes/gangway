import { mayRunContainers, type Actor } from "../auth/actor.ts";
import { forbidden } from "../errors.ts";

const NEEDS_CONTAINER =
  'needs a container, and this credential may deploy only artifacts and static sites gangway serves itself (the "previews.deploy" permission, or the deploy scope, covers containers)';

/** An image or a repository always runs in a container; an upload is judged once it is planned. */
export function checkContainerAllowed(actor: Actor, what: string, container: boolean): void {
  if (container && !mayRunContainers(actor)) throw forbidden(`${what} ${NEEDS_CONTAINER}`);
}
