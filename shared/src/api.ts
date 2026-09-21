/**
 * Request schemas for the public API. ADR-0003: the REST handler, the webhook receiver
 * and the MCP `deploy` tool all validate with THESE, so there is one definition of what a
 * deploy request is, shared with the Angular client for free.
 */
import { z } from "zod";

/** A Docker image reference. Conservative on purpose: it becomes an argument to a CLI. */
const imageRef = z.string().max(255).regex(/^[a-z0-9][a-z0-9._/:@-]*$/i, "not a valid image reference");

const envMap = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name"),
  z.string().max(32_768),
).refine((e) => Object.keys(e).length <= 100, "at most 100 variables");

export const DeploySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("image"),
    image: imageRef,
    /** The port the app listens on INSIDE the container. */
    port: z.number().int().min(1).max(65535),
    env: envMap.optional(),
  }),
]);

export const DeployRequestSchema = z.strictObject({
  source: DeploySourceSchema,
  name: z.string().min(1).max(40).optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  /** `12h`, `7d`; null for no expiry. Omitted means the server default. */
  ttl: z.string().max(16).nullable().optional(),
  hostId: z.string().min(1).max(64).optional(),
});
export type DeployRequest = z.infer<typeof DeployRequestSchema>;

export const PreviewListQuerySchema = z.object({
  state: z.enum(["building", "starting", "awake", "asleep", "failed", "destroying", "destroyed"]).optional(),
  hostId: z.string().optional(),
});
