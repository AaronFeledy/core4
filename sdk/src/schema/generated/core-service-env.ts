/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-core-service-env-catalog.ts`.
 * Source of truth: runtime sites that inject core-owned service environment.
 */
export const CORE_SERVICE_ENV_KEYS = [
  "LANDO",
  "LANDO_APP_KIND",
  "LANDO_APP_NAME",
  "LANDO_APP_ROOT",
  "LANDO_CA_BUNDLE",
  "LANDO_CA_CERT",
  "LANDO_CA_DIR",
  "LANDO_DB_NAME",
  "LANDO_DB_PASSWORD",
  "LANDO_DB_ROOT_PASSWORD",
  "LANDO_DB_USER",
  "LANDO_HOST_GID",
  "LANDO_HOST_HOME",
  "LANDO_HOST_IP",
  "LANDO_HOST_OS",
  "LANDO_HOST_PROXY_APP",
  "LANDO_HOST_PROXY_DEPTH",
  "LANDO_HOST_PROXY_SESSION",
  "LANDO_HOST_PROXY_SHIM",
  "LANDO_HOST_PROXY_SOCKET",
  "LANDO_HOST_PROXY_TOKEN",
  "LANDO_HOST_PROXY_TRANSPORT",
  "LANDO_HOST_PROXY_URL",
  "LANDO_HOST_UID",
  "LANDO_HOST_USER",
  "LANDO_MAIL_HOST",
  "LANDO_MAIL_PORT",
  "LANDO_PROJECT",
  "LANDO_PROJECT_MOUNT",
  "LANDO_SERVICE_API",
  "LANDO_SERVICE_CERT",
  "LANDO_SERVICE_KEY",
  "LANDO_SERVICE_NAME",
  "LANDO_SERVICE_TYPE",
  "LANDO_WEBROOT",
] as const;

const CORE_SERVICE_ENV_KEY_SET: ReadonlySet<string> = new Set(CORE_SERVICE_ENV_KEYS);

export const isCoreServiceEnvKey = (key: string): boolean => CORE_SERVICE_ENV_KEY_SET.has(key);
