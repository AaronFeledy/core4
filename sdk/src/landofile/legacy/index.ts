/**
 * `LEGACY` Landofile parse mode.
 *
 * The Lando 3 dialect is read here and nowhere else: quoted and block scalars,
 * populated flow collections, anchors, bounded aliases, and arbitrary tags kept
 * as data, with a source span on every node. `mode: "legacy"` is a required
 * literal so no v4 caller can fall into this dialect by default, and the v4
 * parser in `../parser.ts` keeps every restriction it has today.
 *
 * A tag is data. `!load` and `!import` survive as tagged values carrying their
 * span; this mode never opens a referenced file.
 */

import { Effect } from "effect";

import { LandofileParseError } from "../../errors/index.ts";
import type { LegacyDocument, LegacyParseOptions } from "./contract.ts";
import { legacyParseError } from "./errors.ts";
import { resolveLegacyLimits } from "./limits.ts";
import { parseLegacyTree } from "./parse.ts";
import { projectLegacyTree } from "./project.ts";

const MODE_REMEDIATION =
  'Pass mode: "legacy" to read the Lando 3 dialect, or use parseLandofile for Lando 4.';

const assertLegacyMode = (mode: string, file: string): void => {
  if (mode !== "legacy") {
    throw legacyParseError(file, `Unsupported Landofile parse mode: ${mode}`, undefined, MODE_REMEDIATION);
  }
};

const parseLegacySync = ({ mode, file, content, limits }: LegacyParseOptions): LegacyDocument => {
  assertLegacyMode(mode, file);

  const resolvedLimits = resolveLegacyLimits(limits);

  const tree = parseLegacyTree(content, file, resolvedLimits);
  const { value, tags } = projectLegacyTree({
    tree,
    file,
    limits: resolvedLimits,
    sourceLength: content.length,
  });

  return { mode: "legacy", file, root: tree.root, value, tags };
};

export const parseLegacyLandofile = (
  options: LegacyParseOptions,
): Effect.Effect<LegacyDocument, LandofileParseError> =>
  Effect.try({
    try: () => parseLegacySync(options),
    catch: (cause) =>
      cause instanceof LandofileParseError
        ? cause
        : new LandofileParseError({
            message: cause instanceof Error ? cause.message : "Failed to parse a Lando 3 Landofile.",
            filePath: options.file,
            line: undefined,
            column: undefined,
            cause,
          }),
  });

export {
  isLegacyTagged,
  LEGACY_TAGGED,
  type LegacyAliasNode,
  type LegacyDocument,
  type LegacyMappingEntry,
  type LegacyMappingNode,
  type LegacyNode,
  type LegacyParseLimits,
  type LegacyParseOptions,
  type LegacyScalarNode,
  type LegacyScalarStyle,
  type LegacySequenceNode,
  type LegacySourcePosition,
  type LegacySourceSpan,
  type LegacyTagged,
  type LegacyTagOccurrence,
  type LegacyTree,
} from "./contract.ts";
