// What this installation may use. A self-hosted gangway has everything; a hosted plan answers
// here, so the check sits in one place rather than beside every feature.
export type Feature = "artifact-customisation";

export const entitled = (_feature: Feature): boolean => true;
