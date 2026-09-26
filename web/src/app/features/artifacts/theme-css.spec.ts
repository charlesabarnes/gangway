import { themeCss } from './theme-css';

describe('themeCss', () => {
  it('writes tokens for light and dark, fonts, the title style and the logo', () => {
    const css = themeCss({
      builtin: false,
      tokens: { light: { ink: '#123456' }, dark: { paper: '#000' } },
      fonts: { sans: 'inter', titles: 'sans' },
      logo: '<svg></svg>',
    });
    expect(css).toContain('--ink:#123456;');
    expect(css).toContain('--font-sans:"Inter"');
    expect(css).toContain('--font-title:var(--font-sans)');
    expect(css).toContain('--logo:url("data:image/svg+xml,');
    expect(css).toContain(':root[data-theme="dark"]{--paper:#000;}');
  });

  it("leaves gangway's own theme to the kit, and drops a value that could escape", () => {
    expect(
      themeCss({ builtin: true, tokens: { light: {}, dark: {} }, fonts: {}, logo: null }),
    ).toBe('');
    const css = themeCss({
      builtin: false,
      tokens: { light: { ink: 'red;}body{display:none' }, dark: {} },
      fonts: {},
      logo: null,
    });
    expect(css).not.toContain('display:none');
  });
});
