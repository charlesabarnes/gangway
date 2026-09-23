import type { DefaultPasswordMode } from "@gangway/shared/domain";
import type { Passwords } from "../auth/password.ts";

export type PreviewPasswordDeps = {
  passwords: Pick<Passwords, "hash">;
  defaultMode: () => DefaultPasswordMode;
  sharedSet?: () => boolean;
  loginDefault?: () => boolean;
};
