/**
 * Seeds the default `lando.*` feature stack when a service omits `type:`.
 * The `lando.env` feature materializes the `LANDO_*` and `/etc/lando` env layer;
 * seed construction only records its id.
 *
 * Core names the ordered ids while the plugin owns their definitions, avoiding
 * a static plugin import. The planner resolves them through the plugin registry.
 */
export const LANDO_BASE_ID = "lando" as const;

export const LANDO_BASE_DEFAULT_FEATURE_IDS: ReadonlyArray<string> = [
  "lando.boot",
  "lando.user-id",
  "lando.storage",
  "lando.env",
  "lando.app-mount",
  "lando.healthcheck",
  "lando.certs",
  "lando.security",
  "lando.host-proxy",
  "lando.user",
];
