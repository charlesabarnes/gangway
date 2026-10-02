import type { PreviewIcon } from "@gangway/shared/preview-icon";
import type {
  Clearance,
  PasswordLogin,
  PasswordMode,
  PreviewKind,
  PreviewSource,
  PreviewState,
  Visibility,
  WatermarkChoice,
} from "@gangway/shared/domain";

export type CreatePreview = {
  id: string;
  project: string;
  title?: string | null;
  icon?: PreviewIcon | null;
  hostId: string;
  kind?: PreviewKind;
  state: PreviewState;
  source: PreviewSource;
  visibility: Visibility;
  ttlExpiresAt?: Date | null;
  idleAfterMs?: number | null;
  secretLevel?: Clearance | null;
  templateId?: string | null;
  projectId?: string | null;
  owner?: string | null;
  credential?: string | null;
  password?: StoredPreviewPassword;
  passwordLogin?: PasswordLogin;
  watermark?: WatermarkChoice | undefined;
  domain?: string | null | undefined;
};

export type StoredPreviewPassword = {
  mode: PasswordMode;
  secret: { hash: string; salt: string } | null;
};

export type PreviewFilter = {
  state?: PreviewState | PreviewState[];
  hostId?: string;
  kind?: PreviewKind;
  projectId?: string;
  includeDestroyed?: boolean;
  /** Only previews this principal deployed (previews.owner). */
  owner?: string;
  /** Only previews this credential deployed (previews.credential). */
  credential?: string;
  /** Only ids below this one: the next page after it. */
  before?: string;
  limit?: number;
};
