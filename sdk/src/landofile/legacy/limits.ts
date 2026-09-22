/**
 * Bounds for the `LEGACY` parse mode.
 *
 * The v4 parser carries its own copies of the byte and depth caps; these stay
 * separate so tuning the legacy dialect can never loosen a v4 restriction.
 */

import type { LegacyParseLimits } from "./contract.ts";
import { legacyParseError } from "./errors.ts";

export const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_DEPTH = 64;
export const DEFAULT_MAX_ALIASES = 1000;

/**
 * Alias expansion multiplies: a few hundred bytes can otherwise expand to
 * gigabytes. A document with no aliases never emits more nodes than it has
 * characters, so a budget of at least the source length never rejects one.
 */
export const MIN_EXPANSION_BUDGET = 50_000;

export interface ResolvedLegacyLimits {
  readonly maxContentBytes: number;
  readonly maxDepth: number;
  readonly maxAliases: number;
}

export const resolveLegacyLimits = (limits?: LegacyParseLimits): ResolvedLegacyLimits => ({
  maxContentBytes: limits?.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES,
  maxDepth: limits?.maxDepth ?? DEFAULT_MAX_DEPTH,
  maxAliases: limits?.maxAliases ?? DEFAULT_MAX_ALIASES,
});

/** Bytes, not characters: a multi-byte document is measured as it is stored. */
export const assertLegacyContentSize = (content: string, file: string, maxContentBytes: number): void => {
  const actualContentBytes = Buffer.byteLength(content, "utf8");
  if (actualContentBytes > maxContentBytes) {
    throw legacyParseError(
      file,
      `Landofile exceeds the maximum input size: ${actualContentBytes} bytes > ${maxContentBytes} bytes`,
      undefined,
      "Split the document or raise the configured maximum input size.",
    );
  }
};

export const expansionBudget = (sourceLength: number): number => Math.max(MIN_EXPANSION_BUDGET, sourceLength);
