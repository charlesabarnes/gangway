import type { Preview, PreviewSource } from '../../core/api.types';

/** One short line for "where did this come from". */
export function sourceLabel(s: PreviewSource): string {
  switch (s.kind) {
    case 'pr': return `${s.repo}#${s.number}`;
    case 'git': return `${s.repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')}@${s.ref}`;
    case 'image': return s.image;
    case 'tarball': {
      const base = s.runtime ? `uploaded files · ${s.runtime}` : 'uploaded archive';
      // ADR-0017: the throwaway databases beside it.
      return s.addons?.length ? `${base} + ${s.addons.map((a) => `${a.id} ${a.version}`).join(', ')}` : base;
    }
    case 'agent': return 'agent';
    case 'manual': return 'manual';
  }
}

/** `gw-` is gangway's namespace on the Docker host, not part of the name a person chose. */
export const displayName = (p: Pick<Preview, 'project'>): string => p.project.replace(/^gw-/, '');

export const primaryUrl = (p: Pick<Preview, 'urls'>): string | null => (p.urls.find((u) => u.primary) ?? p.urls[0])?.url ?? null;
