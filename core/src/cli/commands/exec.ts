/** `lando exec` result rendering. */
import type { ExecAppResult } from "@lando/sdk/app";

/** Mirrors the executed command's non-zero exit code onto the CLI process. */
export const renderExecAppResult = (result: ExecAppResult): string | undefined => {
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
  if (result.stdout.length === 0) return undefined;
  // Callers append their own newline.
  return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
};
