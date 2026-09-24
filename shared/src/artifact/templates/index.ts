import { z } from "zod";
import { ARTIFACT_ACCENTS, ARTIFACT_FILE, ARTIFACT_THEMES, type ArtifactKind } from "../vocab.ts";
import { DASHBOARD_TEMPLATES } from "./dashboard.ts";
import { DECK_TEMPLATES } from "./deck.ts";
import { DOCUMENT_TEMPLATES } from "./document.ts";
import type { ArtifactTemplate, OptionValue, TemplateOption, TemplateSettings } from "./kit.ts";
import { PROTOTYPE_TEMPLATES } from "./prototype.ts";

export type { ArtifactTemplate, OptionValue, TemplateOption } from "./kit.ts";

export const ARTIFACT_TEMPLATES: readonly ArtifactTemplate[] = [
  ...DOCUMENT_TEMPLATES,
  ...DASHBOARD_TEMPLATES,
  ...DECK_TEMPLATES,
  ...PROTOTYPE_TEMPLATES,
];

export const templateById = (id: string): ArtifactTemplate | undefined =>
  ARTIFACT_TEMPLATES.find((t) => t.id === id);
export const templatesFor = (kind: ArtifactKind): ArtifactTemplate[] =>
  ARTIFACT_TEMPLATES.filter((t) => t.kind === kind);

export type TemplateInfo = Omit<ArtifactTemplate, "build">;
export const templateInfo = ({ build: _, ...info }: ArtifactTemplate): TemplateInfo => info;

export const TemplateInputSchema = z.strictObject({
  template: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(120).optional(),
  subtitle: z.string().trim().max(300).optional(),
  theme: z.enum(ARTIFACT_THEMES).optional(),
  accent: z.enum(ARTIFACT_ACCENTS).optional(),
  options: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
});
export type TemplateInput = z.infer<typeof TemplateInputSchema>;

export class TemplateError extends Error {}

function optionValue(o: TemplateOption, v: OptionValue | undefined): OptionValue {
  if (v === undefined) return o.default;
  if (o.kind === "number") {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new TemplateError(`options.${o.key}: expected a number`);
    return Math.min(o.max, Math.max(o.min, Math.round(n)));
  }
  if (o.kind === "boolean") {
    if (typeof v === "boolean") return v;
    if (v === "true" || v === "false") return v === "true";
    throw new TemplateError(`options.${o.key}: expected true or false`);
  }
  const s = String(v);
  if (!o.choices.some((c) => c.value === s))
    throw new TemplateError(`options.${o.key}: one of ${o.choices.map((c) => c.value).join(", ")}`);
  return s;
}

export function settingsFor(
  t: ArtifactTemplate,
  input: Omit<TemplateInput, "template">,
): TemplateSettings {
  const given = input.options ?? {};
  const unknown = Object.keys(given).filter((k) => !t.options.some((o) => o.key === k));
  if (unknown.length > 0)
    throw new TemplateError(
      `${t.id} has no option ${unknown.join(", ")}; it takes ${t.options.map((o) => o.key).join(", ") || "none"}`,
    );
  return {
    title: input.title ?? t.title,
    subtitle: input.subtitle ?? t.subtitle,
    theme: input.theme ?? "system",
    accent: input.accent ?? "flag",
    opts: Object.fromEntries(t.options.map((o) => [o.key, optionValue(o, given[o.key])])),
  };
}

export function renderTemplate(input: TemplateInput): Record<string, string> {
  const t = templateById(input.template);
  if (!t)
    throw new TemplateError(
      `no template "${input.template}"; one of ${ARTIFACT_TEMPLATES.map((x) => x.id).join(", ")}`,
    );
  const { markdown, data } = t.build(settingsFor(t, input));
  return { [ARTIFACT_FILE]: markdown, ...(data ?? {}) };
}

export function optionText(o: TemplateOption): string {
  if (o.kind === "number") return `${o.key}: ${o.min}-${o.max} (default ${o.default})`;
  if (o.kind === "boolean") return `${o.key}: true|false (default ${o.default})`;
  return `${o.key}: ${o.choices.map((c) => c.value).join("|")} (default ${o.default})`;
}

export function templatesText(kind: ArtifactKind): string {
  return templatesFor(kind)
    .map(
      (t) =>
        `- ${t.id}: ${t.description}\n  options: ${t.options.map(optionText).join("; ") || "none"}`,
    )
    .join("\n");
}
