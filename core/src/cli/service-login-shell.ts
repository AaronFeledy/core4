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
