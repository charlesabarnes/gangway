import { z } from "zod";
import { isDomainName } from "./hostname.ts";

/** A domain or hostname as DNS holds it: lowercase, no wildcard, no trailing dot. */
export const DomainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/\.$/, ""))
  .refine(isDomainName, "not a domain name like previews.example.com");

/** A wildcard names previews `<label>.<name>`; an exact hostname answers for one site. */
export const DomainClaimSchema = z.strictObject({
  name: DomainNameSchema,
  kind: z.enum(["wildcard", "exact"]),
});
export const DomainClaimForPreviewSchema = z.strictObject({ name: DomainNameSchema });
/** The preview a project's own hostnames answer for; null answers for none. */
export const ProductionChangeSchema = z.strictObject({ previewId: z.string().min(1).nullable() });

/** null follows the project, then the server's default. */
export const PreviewDomainChangeSchema = z.strictObject({ domain: DomainNameSchema.nullable() });
