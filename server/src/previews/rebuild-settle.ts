import type { PreviewContext } from "./context.ts";
import type { RedeployOutcome } from "./rebuild-failure.ts";
import type { Preview } from "@gangway/shared/domain";

type Settling = {
  id: string;
  preview: Preview;
  buildId: string;
  reserve: number;
  kept: number;
  settle: (o: RedeployOutcome) => void;
};

export function settleWhenDone(
  ctx: PreviewContext,
  work: Promise<RedeployOutcome>,
  c: Settling,
): void {
  const { id, settle } = c;
  void work
    .then(
      (o) => {
        try {
          ctx.previews.setReservedBytes(id, o.outcome === "succeeded" ? c.reserve : c.kept);
        } finally {
          settle(o);
        }
      },
      (e: unknown) => {
        try {
          ctx.previews.setReservedBytes(id, c.kept);
        } finally {
          settle({
            preview: ctx.previews.get(id) ?? c.preview,
            buildId: c.buildId,
            outcome: "failed",
            error: String(e),
          });
        }
      },
    )
    .catch((err: unknown) => {
      ctx.logger.error("a rebuild could not record its reservation", { previewId: id, err });
    });
}
