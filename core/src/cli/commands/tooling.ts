/** `lando <tool>` result rendering. */
import type { RunToolingResult } from "@lando/engine/operations/tooling";

export const renderRunToolingResult = (result: RunToolingResult): string | undefined =>
  result.stdout.length === 0 ? undefined : result.stdout;
