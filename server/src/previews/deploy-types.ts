import type { PreviewIcon } from "@gangway/shared/preview-icon";
import type {
  BrandChoice,
  Clearance,
  NetworkChoice,
  Preview,
  Visibility,
  PasswordLogin,
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
      port?: number | undefined;
      digest?: string | undefined;
      runtime?: RuntimeChoice | undefined;
      addons?: readonly AddonRequest[] | undefined;
      network?: NetworkChoice | undefined;
      brand?: BrandChoice | undefined;
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
};

export type PreviewUrl = { service: string; url: string; primary: boolean };

export type DeployResult = {
  preview: Preview;
  urls: PreviewUrl[];
  done: Promise<Preview>;
  plan?: AppPlan | undefined;
};
