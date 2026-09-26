export type ArtifactKind = 'document' | 'deck';
export type ArtifactAccent = 'flag' | 'red' | 'teal' | 'blue' | 'green';
export type ArtifactMode = 'system' | 'light' | 'dark';
export type ArtifactMeta = {
  kind: ArtifactKind;
  title: string;
  description: string | null;
  mode: ArtifactMode;
  /** A theme by id; null follows the server's default. */
  theme: string | null;
  accent: ArtifactAccent;
  css: string | null;
  format: 'markdown' | 'html';
};
/** The gangway watermark on a preview: inherit follows the repository, then the setting. */
export type WatermarkChoice = 'inherit' | 'on' | 'off';
