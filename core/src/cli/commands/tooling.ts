/** `lando <tool>` result rendering. The operation lives in `core/src/operations/tooling.ts`. */
import type { RunToolingResult } from "../../operations/tooling.ts";

export const renderRunToolingResult = (result: RunToolingResult): string | undefined =>
  result.rendered === true || result.stdout.length === 0 ? undefined : result.stdout;
