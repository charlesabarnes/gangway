import type { Permission } from '../../core/api.types';

export type AdminTab = 'users' | 'roles' | 'previews' | 'domains' | 'github' | 'server' | 'audit';

/** Admin's tabs in order; a tab shows if the role holds any of its permissions. */
export const ADMIN_TABS: readonly { id: AdminTab; label: string; any: readonly Permission[] }[] = [
  { id: 'users', label: 'Users', any: ['users.read'] },
  { id: 'roles', label: 'Roles', any: ['roles.read'] },
  {
    id: 'previews',
    label: 'Previews',
    any: ['settings.read', 'templates.manage', 'repos.secrets'],
  },
  { id: 'domains', label: 'Domains & traffic', any: ['settings.read'] },
  { id: 'github', label: 'GitHub', any: ['github.manage'] },
  { id: 'server', label: 'Server', any: ['settings.read', 'surfaces.manage'] },
  { id: 'audit', label: 'Audit log', any: ['audit.read'] },
];

export function adminTabs(can: (p: Permission) => boolean) {
  return ADMIN_TABS.filter((t) => t.any.some(can));
}
