/**
 * Shared contracts for rebuild-surviving container shell and client history.
 *
 * One app-scoped data volume is mounted whole at {@link HISTORY_MOUNT_TARGET}.
 * History files are flat (`<service>.<client>_history`). Docker volume Subpath
 * is intentionally unused: the negotiated Engine API is 1.43.
 */

export const HISTORY_FEATURE_ID = "service-lando.history" as const;

export const HISTORY_MOUNT_TARGET = "/run/lando/history" as const;

/** Default-on lando-base types that ship known interactive clients. */
export const HISTORY_DEFAULT_SERVICE_TYPES = [
  "mysql",
  "mysql:8.0",
  "mysql:8.4",
  "mysql:9.7",
  "mariadb",
  "postgres",
  "redis",
  "php:8.1",
  "php:8.2",
  "php:8.3",
  "php:8.4",
  "php:8.5",
  "php:8.6",
  "node",
  "node:lts",
  "node:22",
  "python:3.12",
] as const;

export type HistoryDefaultServiceType = (typeof HISTORY_DEFAULT_SERVICE_TYPES)[number];

const HISTORY_DEFAULT_FAMILIES = new Set(
  HISTORY_DEFAULT_SERVICE_TYPES.map((type) => type.split(":")[0] ?? type),
);

export const HISTORY_STORE_NAME_PATTERN = /^lando-.+-history$/;

export const historyStoreName = (appName: string): string => `lando-${appName}-history`;

export const isHistoryStoreName = (name: string): boolean => HISTORY_STORE_NAME_PATTERN.test(name);

export const isHistoryMountTarget = (target: string): boolean => target === HISTORY_MOUNT_TARGET;

export const historyServiceTypeFamily = (serviceType: string): string =>
  serviceType.split(":")[0] ?? serviceType;

export const isHistoryDefaultServiceType = (serviceType: string): boolean =>
  HISTORY_DEFAULT_FAMILIES.has(historyServiceTypeFamily(serviceType));

/**
 * Exec-time histfile variables. MYSQL and MARIADB share `mysql_history` so the
 * mysql client and mariadb client on the same service write one file.
 * PYTHON_HISTORY is honored by Python 3.13+ only.
 */
export const HISTORY_CLIENT_FILES = {
  HISTFILE: "bash_history",
  MYSQL_HISTFILE: "mysql_history",
  MARIADB_HISTFILE: "mysql_history",
  PSQL_HISTORY: "psql_history",
  REDISCLI_HISTFILE: "redis_history",
  SQLITE_HISTORY: "sqlite_history",
  NODE_REPL_HISTORY: "node_history",
  PYTHON_HISTORY: "python_history",
} as const;

export type HistoryClientEnvName = keyof typeof HISTORY_CLIENT_FILES;

export const HISTORY_CLIENT_ENV_NAMES = Object.keys(
  HISTORY_CLIENT_FILES,
) as ReadonlyArray<HistoryClientEnvName>;

export const historyFilePath = (serviceName: string, clientFile: string): string =>
  `${HISTORY_MOUNT_TARGET}/${serviceName}.${clientFile}`;

export const shouldAttachHistoryVolume = (input: {
  readonly serviceType: string;
  readonly history?: boolean | undefined;
}): boolean => {
  if (input.history === false) return false;
  if (input.history === true) return true;
  return isHistoryDefaultServiceType(input.serviceType);
};
