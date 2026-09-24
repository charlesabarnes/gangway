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
export type BrandChoice = 'inherit' | 'on' | 'off';
