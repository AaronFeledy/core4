/** `lando <tool>` result rendering. */
import type { RunToolingResult } from "../../operations/tooling.ts";

export const renderRunToolingResult = (result: RunToolingResult): string | undefined =>
  result.rendered === true || result.stdout.length === 0 ? undefined : result.stdout;
