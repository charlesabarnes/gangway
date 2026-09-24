import { TestBed } from '@angular/core/testing';
import { PREVIEW_ICONS } from '../core/preview-icon.types';
import { render } from '../../testing/render';
import { ICON_NODES, PreviewIconTile } from './preview-icon';

describe('PreviewIconTile', () => {
  it('draws every icon the server accepts', () => {
    expect(Object.keys(ICON_NODES).sort()).toEqual([...PREVIEW_ICONS].sort());
  });

  it('draws the chosen icon in its colour', async () => {
    const r = await render(PreviewIconTile, {
      inputs: { icon: { name: 'rocket', color: 'teal' }, size: 40 },
    });
    expect(r.el.getAttribute('data-icon')).toBe('rocket');
    expect(r.el.style.color).toContain('rgb(0, 133, 127)');
    expect(r.el.querySelector('svg')?.getAttribute('width')).toBe('22');
    expect(r.el.querySelectorAll('svg > *').length).toBeGreaterThan(0);
  });

  it('falls back to a grey icon for the source without one', async () => {
    const r = await render(PreviewIconTile, { inputs: { icon: null, source: 'pr' } });
    expect(r.el.hasAttribute('data-icon')).toBe(false);
    expect(r.el.style.color).toContain('rgb(104, 114, 131)');
    expect(r.el.querySelector('svg')).not.toBeNull();
    TestBed.resetTestingModule();
  });
});
