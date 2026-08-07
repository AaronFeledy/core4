/** `lando exec` result rendering. The operation lives in `core/src/operations/exec.ts`. */
import type { ExecAppResult } from "@lando/sdk/app";

/**
 * Mirrors the exec exit code onto the process so the CLI surfaces the tool's
 * status (side-effect render pattern, identical for source and compiled
 * entries of the native dispatcher).
 */
export const renderExecAppResult = (result: ExecAppResult): string | undefined => {
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
  if (result.stdout.length === 0) return undefined;
  // Strip one trailing newline so callers don't add a second one.
  return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
};
