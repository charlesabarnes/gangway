import type { AddonRequest } from "@gangway/shared/app-plan";
import type { BrandChoice, NetworkChoice } from "@gangway/shared/domain";
import type { Actor } from "../auth/actor.ts";
import type { RuntimeChoice } from "./runtimes.ts";
import type { SourceEdits } from "./source-edits.ts";
import type { TarballSource } from "./source/tarball.ts";

export type RedeployInput = {
  actor: Actor;
  previewId: string;
  change: { kind: "replace"; archive: TarballSource } | { kind: "edit"; files: SourceEdits };
  runtime?: RuntimeChoice | undefined;
  addons?: readonly AddonRequest[] | undefined;
  network?: NetworkChoice | undefined;
  brand?: BrandChoice | undefined;
};
