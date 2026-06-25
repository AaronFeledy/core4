/**
 * `lando` service base contract.
 *
 * Opinionated dev service. Seeds the default `lando.*` feature stack in
 * canonical priority order (including `lando.env`); the `LANDO_*` / `/etc/lando`
 * env layer is materialized when the `lando.env` feature runs, not at seed
 * time. The default when `type:` is omitted on a v4 service.
 *
 * Feature definitions live in `@lando/service-lando`; the base names only the
 * ordered default feature ids so core stays free of a static plugin import.
 * The planner resolves these ids to definitions via the plugin registry.
 */
export const LANDO_BASE_ID = "lando" as const;

export const LANDO_BASE_DEFAULT_FEATURE_IDS: ReadonlyArray<string> = [
  "lando.user-id",
  "lando.storage",
  "lando.env",
  "lando.app-mount",
  "lando.healthcheck",
  "lando.user",
];
