import { type Preview, projectNameFor } from "@gangway/shared/domain";
import { can, maySee, type Actor } from "../auth/actor.ts";
import { notFound, unprocessable } from "../errors.ts";
import type { PreviewContext } from "../previews/context.ts";
import { isUlid } from "../util/ulid.ts";

export function nameOf(ctx: Pick<PreviewContext, "instance">, p: Preview): string {
  const prefix = projectNameFor(ctx.instance, "");
  return p.project.startsWith(prefix) ? p.project.slice(prefix.length) : p.project;
}

const isLive = (p: Preview | undefined): p is Preview => p !== undefined && p.state !== "destroyed";

/** `visible` narrows the search, so a name the caller may not see is simply not found. */
export function resolvePreview(
  ctx: PreviewContext,
  ref: string,
  visible: (p: Preview) => boolean = () => true,
): Preview {
  const live = (p: Preview | undefined): p is Preview => isLive(p) && visible(p);
  const text = ref.trim();
  if (text === "") throw unprocessable("name a preview: its name, URL or id");

  if (isUlid(text.toUpperCase())) {
    const p = ctx.previews.get(text.toUpperCase());
    if (live(p)) return p;
  }

  let host = text.toLowerCase();
  if (/^https?:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      throw unprocessable(`${JSON.stringify(text)} is not a URL`);
    }
  }
  if (host.includes(".")) {
    const entry = ctx.table.lookup(host);
    const p = entry ? ctx.previews.get(entry.previewId) : undefined;
    if (live(p)) return p;
    throw notFound(`no preview answers at ${host}`);
  }

  const all = ctx.previews.list({}).filter(live);
  const exact = all.filter((p) => nameOf(ctx, p) === host);
  if (exact.length === 1) return exact[0]!;
  const stem =
    exact.length === 0
      ? all.filter((p) =>
          new RegExp(`^${host.replace(/[^a-z0-9-]/g, "")}-[a-z0-9]{10}$`).test(nameOf(ctx, p)),
        )
      : exact;
  if (stem.length === 1) return stem[0]!;
  if (stem.length > 1)
    throw unprocessable(
      `${JSON.stringify(text)} matches ${stem.length} previews: ${stem.map((p) => `${nameOf(ctx, p)} (${p.id})`).join(", ")}. Use the URL or the id`,
    );
  throw notFound(`no live preview is called ${JSON.stringify(text)}`);
}

/** What this actor may see: everything, or only what it deployed. */
export function visibleTo(ctx: PreviewContext, actor: Actor): (p: Preview) => boolean {
  if (can(actor, "previews.read")) return () => true;
  const made = ctx.previews.provenances();
  return (p) => maySee(actor, made.get(p.id) ?? { owner: null, credential: null });
}

export const resolveFor = (ctx: PreviewContext, actor: Actor, ref: string): Preview =>
  resolvePreview(ctx, ref, visibleTo(ctx, actor));
