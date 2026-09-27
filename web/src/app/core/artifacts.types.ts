import type { ArtifactKind, ArtifactMode } from './artifact.types';
import type { Preview } from './api.types';

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['document', 'deck', 'canvas'];
export const KIND_LABELS: Record<ArtifactKind, string> = {
  document: 'Document',
  deck: 'Presentation',
  canvas: 'Canvas',
};

export const THEME_TOKENS = [
  'paper',
  'paper-raised',
  'ink',
  'ink-muted',
  'rule',
  'primary',
  'on-primary',
  'flag',
  'on-flag',
  'awake',
  'warn',
  'danger',
  'header-bg',
  'header-fg',
  'header-muted',
  'header-rule',
  'log-bg',
  'log-fg',
  's1',
  's2',
  's3',
  's4',
  's5',
  's6',
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
export type TokenMap = Partial<Record<ThemeToken, string>>;
export type ThemeFonts = {
  serif?: string;
  sans?: string;
  mono?: string;
  display?: string;
  titles?: 'italic-serif' | 'serif' | 'sans' | 'display';
  titleWeight?: 'light' | 'regular' | 'semibold' | 'bold';
  titleCase?: 'normal' | 'upper';
};

/** A theme's shape and layout; each key is one of ThemeList.style's choices, the first gangway's. */
export const THEME_STYLE_KEYS = [
  'corners',
  'edges',
  'stroke',
  'nodes',
  'grid',
  'density',
  'text',
  'headings',
] as const;
export type ThemeStyleKey = (typeof THEME_STYLE_KEYS)[number];
export type ThemeStyle = Partial<Record<ThemeStyleKey, string>>;

export type ArtifactTheme = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  isDefault: boolean;
  tokens: { light: TokenMap; dark: TokenMap };
  fonts: ThemeFonts;
  style?: ThemeStyle;
  logo: string | null;
};

export type ThemeList = {
  themes: ArtifactTheme[];
  defaultTheme: string;
  house: { light: Record<ThemeToken, string>; dark: Record<ThemeToken, string> };
  fonts: { serif: string[]; sans: string[]; mono: string[]; display: string[] };
  fontLabels: Record<string, string>;
  titles: NonNullable<ThemeFonts['titles']>[];
  titleWeights: NonNullable<ThemeFonts['titleWeight']>[];
  titleCases: NonNullable<ThemeFonts['titleCase']>[];
  style: Record<ThemeStyleKey, string[]>;
};

export type TemplateOption =
  | { key: string; label: string; kind: 'number'; min: number; max: number; default: number }
  | {
      key: string;
      label: string;
      kind: 'choice';
      choices: { value: string; label: string }[];
      default: string;
    }
  | { key: string; label: string; kind: 'boolean'; default: boolean };
export type OptionValue = number | string | boolean;

export type TemplateSummary = {
  id: string;
  kind: ArtifactKind;
  name: string;
  description: string;
  builtin: boolean;
  options: TemplateOption[];
  themeId: string | null;
};

export type TemplateInput = {
  template: string;
  title?: string;
  subtitle?: string;
  mode?: ArtifactMode;
  theme?: string;
  accent?: string;
  options?: Record<string, OptionValue>;
};

export type ArtifactItem = { preview: Preview; kind: ArtifactKind | null; theme: string | null };

/** Every token a theme sets, or the house value, for the editor. */
export const TOKEN_LABELS: Record<ThemeToken, string> = {
  paper: 'Paper',
  'paper-raised': 'Raised paper',
  ink: 'Ink',
  'ink-muted': 'Muted ink',
  rule: 'Rules',
  primary: 'Primary',
  'on-primary': 'On primary',
  flag: 'Flag (accent)',
  'on-flag': 'On flag',
  awake: 'Good',
  warn: 'Warning',
  danger: 'Danger',
  'header-bg': 'Navy slides',
  'header-fg': 'On navy',
  'header-muted': 'Muted on navy',
  'header-rule': 'Rules on navy',
  'log-bg': 'Code block',
  'log-fg': 'Code text',
  s1: 'Series 1',
  s2: 'Series 2',
  s3: 'Series 3',
  s4: 'Series 4',
  s5: 'Series 5',
  s6: 'Series 6',
};
