/**
 * Failure construction for the `LEGACY` parse mode.
 *
 * `LEGACY` reuses `LandofileParseError` so a caller handles one tagged failure
 * for both dialects; only the message and remediation differ.
 */

import { LandofileParseError } from "../../errors/index.ts";

interface LegacyErrorPosition {
  readonly line: number;
  readonly column: number;
}

export const legacyParseError = (
  file: string,
  message: string,
  position?: LegacyErrorPosition,
  remediation?: string,
): LandofileParseError =>
  new LandofileParseError({
    message,
    filePath: file,
    line: position?.line,
    column: position?.column,
    remediation,
  });
