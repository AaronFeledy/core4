/**
 * Default in-container login shell for `lando shell --service` and `lando ssh`.
 *
 * Debian-based images ship dash as `sh`, which has no line editing or history.
 * Prefer bash when the image has it; keep `sh -l` on images that do not (Alpine).
 */
export const SERVICE_LOGIN_SHELL_SCRIPT = "command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l";

export const DEFAULT_SERVICE_LOGIN_SHELL: ReadonlyArray<string> = ["sh", "-c", SERVICE_LOGIN_SHELL_SCRIPT];

export const serviceLoginShellCommand = (
  override: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> =>
  override === undefined || override.length === 0 ? DEFAULT_SERVICE_LOGIN_SHELL : override;

export const SESSION_NO_HISTORY_ENV = {
  HISTFILE: "", // Bash and busybox ash skip loading and saving when empty.
  MYSQL_HISTFILE: "/dev/null", // MySQL and older MariaDB clients special-case this path.
  MARIADB_HISTFILE: "/dev/null", // Newer MariaDB clients use their own variable.
  PSQL_HISTORY: "/dev/null", // psql skips writing this path.
  REDISCLI_HISTFILE: "/dev/null", // redis-cli treats this path as history disabled.
  NODE_REPL_HISTORY: "", // An empty value disables persistent REPL history.
  PYTHON_HISTORY: "/dev/null", // Python 3.13+ redirects REPL history away from the home.
} as const;

export const withSessionNoHistoryEnv = (
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({ ...env, ...SESSION_NO_HISTORY_ENV });
