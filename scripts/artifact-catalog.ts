import { guideMarkdown } from "../shared/src/artifact/index.ts";

export const CATALOG_MD = "plugin/gangway/skills/generate-artifact/catalog.md";

await Bun.write(CATALOG_MD, guideMarkdown());
console.log(`wrote ${CATALOG_MD}`);
