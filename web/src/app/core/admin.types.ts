import type { Permission } from './api.types';

export type User = {
  id: string;
  email: string;
  roleId: string;
  disabled: boolean;
  /** Emailed a link to set a first password, and has not used it yet. */
  invited: boolean;
  createdAt: string;
};

export type Role = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  createdAt: string;
  permissions: Permission[];
  /** False for admin, which holds every permission whatever the matrix says. */
  editable: boolean;
};

export type PermissionInfo = { id: Permission; feature: string; description: string };
export type RolesResponse = { roles: Role[]; catalogue: PermissionInfo[] };

export type AuditEntry = {
  seq: number;
  actorType: 'user' | 'token' | 'app' | 'system' | 'github';
  actorId: string | null;
  action: string;
  target: string | null;
  old: unknown;
  new: unknown;
  createdAt: string;
};
export type AuditPage = { entries: AuditEntry[]; nextBefore: number | null };
