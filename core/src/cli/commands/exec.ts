/** `lando exec` result rendering. */
import type { ExecAppResult } from "@lando/sdk/app";

export const renderExecAppResult = (result: ExecAppResult): string | undefined => {
  if (result.stdout.length === 0) return undefined;
  // Callers append their own newline.
  return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
};
