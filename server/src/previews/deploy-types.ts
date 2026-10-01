import type { PreviewIcon } from "@gangway/shared/preview-icon";
import type {
  WatermarkChoice,
  Clearance,
  NetworkChoice,
  Preview,
  Visibility,
  PasswordLogin,
  PullRequestRef,
} from "@gangway/shared/domain";
import type { AddonRequest, AppPlan } from "@gangway/shared/app-plan";
import type { PasswordChoice } from "@gangway/shared/api";
import type { Actor } from "../auth/actor.ts";
import type { RuntimeChoice } from "./runtimes.ts";
import type { TarballSource } from "./source/tarball.ts";

export type DeploySource =
  | {
      kind: "image";
      image: string;
      port: number;
      env?: Record<string, string> | undefined;
      network?: NetworkChoice | undefined;
    }
  | { kind: "git"; repo: string; ref: string; port?: number | undefined }
  | {
      kind: "pr";
      repo: string;
      number: number;
      sha: string;
      cloneUrl: string;
      credential: string | undefined;
      port?: number | undefined;
    }
  | {
      kind: "tarball";
      archive: TarballSource;
      pr?: PullRequestRef | undefined;
      port?: number | undefined;
      digest?: string | undefined;
      runtime?: RuntimeChoice | undefined;
      addons?: readonly AddonRequest[] | undefined;
      network?: NetworkChoice | undefined;
    }
  | {
      kind: "pushed";
      image: string;
      port: number;
      pr: { repo: string; number: number; sha: string };
      registry?: RegistryLogin | undefined;
    };

export type RegistryLogin = { server: string; username: string; password: string };

export type DeployInput = {
  actor: Actor;
  source: DeploySource;
  env?: Record<string, string> | undefined;
  /** Secrets for this preview alone, set at deploy time: stored on it and kept across rebuilds. */
  secrets?: Record<string, string> | undefined;
  /** The sealed secrets of the preview this one replaces (a PR's new head), carried as-is. */
  carrySecrets?: string | null | undefined;
  secretLevel?: Clearance | undefined;
  name?: string | undefined;
  title?: string | undefined;
  icon?: PreviewIcon | undefined;
  visibility?: Visibility | undefined;
  ttl?: string | null | undefined;
  hostId?: string | undefined;
  template?: string | undefined;
  projectId?: string | undefined;
  password?: PasswordChoice | undefined;
  passwordLogin?: PasswordLogin | undefined;
  watermark?: WatermarkChoice | undefined;
  /** The wildcard domain chosen; absent follows the project, then the default. */
  domain?: string | undefined;
};

export type PreviewUrl = {
  service: string;
  url: string;
  primary: boolean;
  /** A custom hostname claimed for it, not one gangway named. */
  custom?: true;
  share?: true;
};

export type DeployResult = {
  preview: Preview;
  urls: PreviewUrl[];
  done: Promise<Preview>;
  plan?: AppPlan | undefined;
};
