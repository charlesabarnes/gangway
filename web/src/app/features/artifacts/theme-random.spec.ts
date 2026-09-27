import { LOOKS, randomTheme } from './theme-random';

describe('randomTheme', () => {
  it('names the theme after its look and hue, and gives every colour', () => {
    const t = randomTheme(() => 0.5);
    expect(t.name).toMatch(new RegExp(`^${t.look} [A-Z][a-z]+$`));
    expect(Object.keys(t.tokens.light)).toHaveLength(24);
    expect(Object.keys(t.tokens.dark)).toHaveLength(24);
  });

  it('never repeats the look it is told to move on from', () => {
    for (const look of LOOKS) {
      for (let i = 0; i < 20; i++) expect(randomTheme(Math.random, look.name).look).not.toBe(look.name);
    }
  });
});
