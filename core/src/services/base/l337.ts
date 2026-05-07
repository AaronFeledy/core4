/**
 * `l337` service base contract.
 *
 * Low-level, artifact-oriented service. Provides artifact-build plumbing
 * and **nothing else**: no `/etc/lando/*` scaffolding, no opinionated env,
 * no packages. The escape hatch.
 *
 * Status: stub. The base contract resolves to a `ServiceTypeResolution`
 * with `base: "l337"` and an empty feature list. User-supplied `artifact:`
 * and other low-level keys are passed through verbatim.
 */
export const L337_BASE_ID = "l337" as const;
