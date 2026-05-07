/**
 * `lando` service base contract.
 *
 * Opinionated dev service. Adds boot scaffolding, an env layer, packages,
 * container-time build steps, app mounts, healthcheck integration, certs,
 * SSH agent, and run hooks.
 *
 * The default when `type:` is omitted on a v4 service.
 *
 * Status: stub. The base contract resolves to a `ServiceTypeResolution`
 * with `base: "lando"` and the built-in feature priority list from
 * `@lando/service-lando`.
 */
export const LANDO_BASE_ID = "lando" as const;
