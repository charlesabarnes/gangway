import { contrast, parseColor, toHex, toOklch } from './color';
import { brandPalette } from './palette';
import { readability } from './readability';

describe('colours', () => {
  it('reads every syntax a theme may use, and refuses what it cannot', () => {
    expect(toHex(parseColor('#f00')!)).toBe('#ff0000');
    expect(toHex(parseColor('rgb(0 128 255)')!)).toBe('#0080ff');
    expect(toHex(parseColor('hsl(120, 100%, 25%)')!)).toBe('#008000');
    expect(toHex(parseColor('oklch(0.628 0.2577 29.23)')!)).toBe('#ff0000');
    expect(parseColor('lab(50 20 20)')).toBeNull();
    expect(parseColor('red')).toBeNull();
  });

  it('turns sRGB into oklch and measures contrast as WCAG does', () => {
    const red = toOklch(parseColor('#ff0000')!);
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.h).toBeCloseTo(29.2, 0);
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrast('#777', '#fff')).toBeCloseTo(4.48, 1);
  });
});

describe('brandPalette', () => {
  it('keeps a brand colour as written, and every pair of colours reads', () => {
    const p = brandPalette('#1d4ed8', null, 'white')!;
    expect(p.light.primary).toBe('#1d4ed8');
    expect(readability(p, { light: {}, dark: {} })).toEqual([]);
  });

  it('makes a colour too light for text the highlight, and a deeper shade the brand', () => {
    const p = brandPalette('#ffd400', null, 'tinted')!;
    expect(p.light.flag).toBe('#ffd400');
    expect(p.light.primary).not.toBe('#ffd400');
    expect(readability(p, { light: {}, dark: {} })).toEqual([]);
  });

  it('takes a second colour as the highlight, and nothing from a colour it cannot read', () => {
    expect(brandPalette('#1d4ed8', '#f97316', 'warm')!.light.flag).toBe('#f97316');
    expect(brandPalette('not a colour', null, 'white')).toBeNull();
  });
});

describe('readability', () => {
  it('names the pair, the mode and the ratio that falls short', () => {
    const [f] = readability(
      { light: { ink: '#999', paper: '#fff' }, dark: {} },
      { light: {}, dark: {} },
    );
    expect(f).toMatchObject({ what: 'Body text', mode: 'light', min: 7 });
    expect(f!.ratio).toBeCloseTo(2.85, 1);
  });
});
