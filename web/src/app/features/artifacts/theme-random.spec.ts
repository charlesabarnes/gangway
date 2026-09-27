import { randomTheme } from './theme-random';

describe('randomTheme', () => {
  it('names the theme with a word and its hue, and gives every colour', () => {
    const t = randomTheme(() => 0.5);
    expect(t.name).toMatch(new RegExp(`^${t.word} [A-Z][a-z]+$`));
    expect(Object.keys(t.tokens.light)).toHaveLength(24);
    expect(Object.keys(t.tokens.dark)).toHaveLength(24);
  });

  it('keeps handwritten titles in their own case and weight', () => {
    for (let i = 0; i < 500; i++) {
      const { fonts } = randomTheme();
      if (fonts.display === 'caveat' || fonts.display === 'kalam') {
        expect(fonts.titleCase).toBeUndefined();
        expect(fonts.titleWeight).not.toBe('light');
      }
    }
  });
});
