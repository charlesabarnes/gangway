import type { ArtifactItem } from '../../core/artifacts.types';
import { sortArtifacts } from './gallery';

const item = (project: string, createdAt: string, updatedAt: string, title?: string) =>
  ({
    preview: { project, title: title ?? null, createdAt, updatedAt },
    kind: 'document',
    theme: null,
  }) as unknown as ArtifactItem;

const items = [
  item('b', '2026-09-02T00:00:00Z', '2026-09-20T00:00:00Z', 'Alpha'),
  item('c', '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z', 'Beta'),
  item('a', '2026-09-01T00:00:00Z', '2026-09-10T00:00:00Z'),
];
const order = (by: Parameters<typeof sortArtifacts>[1]) =>
  sortArtifacts(items, by).map((a) => a.preview.project);

describe('sortArtifacts', () => {
  it('puts the newest first by default, and the oldest first when asked', () => {
    expect(order('newest')).toEqual(['c', 'b', 'a']);
    expect(order('oldest')).toEqual(['a', 'b', 'c']);
  });

  it('sorts by the last update, and by the name people see', () => {
    expect(order('updated')).toEqual(['b', 'a', 'c']);
    expect(order('name')).toEqual(['a', 'b', 'c']);
  });

  it('leaves the list it was given alone', () => {
    sortArtifacts(items, 'newest');
    expect(items.map((a) => a.preview.project)).toEqual(['b', 'c', 'a']);
  });
});
