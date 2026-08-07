/**
 * `l337` service base contract.
 *
 * Low-level, artifact-oriented service. Provides artifact-build plumbing and
 * **nothing else**: no `/etc/lando/*` scaffolding, no opinionated env, no
 * packages, no app mount. It seeds an empty default feature list, so no
 * `lando.*` feature and therefore no `LANDO_*` env layer is ever materialized;
 * only the user/Compose-authored `environment:` carried by the base seed
 * survives. The escape hatch.
 */
export const L337_BASE_ID = "l337" as const;

export const L337_BASE_DEFAULT_FEATURE_IDS: ReadonlyArray<string> = [];
