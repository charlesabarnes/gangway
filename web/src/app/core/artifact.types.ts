export type ArtifactKind = 'document' | 'dashboard' | 'deck' | 'prototype';
export type ArtifactAccent = 'flag' | 'red' | 'teal' | 'blue' | 'green';
export type ArtifactTheme = 'system' | 'light' | 'dark';
export type ArtifactMeta = {
  kind: ArtifactKind;
  title: string;
  description: string | null;
  theme: ArtifactTheme;
  accent: ArtifactAccent;
  format: 'markdown' | 'html';
};
/** The gangway watermark on a preview: inherit follows the repository, then the setting. */
export type WatermarkChoice = 'inherit' | 'on' | 'off';
