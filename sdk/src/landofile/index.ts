// `@lando/sdk/landofile` — canonical pure Landofile emit/parse (no Effect layers,
// filesystem, or CLI). `@lando/core/landofile` re-exports for in-tree writers.

export {
  emitLandofileYaml,
  emitLandofileYamlEither,
  LANDOFILE_LEADING_COMMENT_BLOCKS,
  type LandofileLeadingCommentBlock,
} from "./emit.ts";
export {
  compareKeyPaths,
  declaredConfigTranslateSourceIds,
  validateConfigTranslateInput,
  validateConfigTranslateResult,
} from "./config-translate.ts";
export { LandofileEmitError } from "./errors.ts";
export { LANDOFILE_LAYER_ORDER, landofileLayerRank } from "./layer-order.ts";
export {
  ARRAY_IDENTITY_KEYS,
  type RouteFilterIdentity,
  identityKeyFor,
  isPlainRecord,
  mergeLandofiles,
  mergeValues,
  routeFilterIdentity,
  routeFilterMatches,
} from "./overlay-merge.ts";
export {
  type ComposeDisposition,
  type ComposeDispositionEntry,
  ComposeDispositionMatrixError,
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "./compose-dispositions.ts";
export {
  detectLandofileTags,
  type LandofileTag,
  type LandofileTagOccurrence,
  type LoadHint,
  parseLandofile,
  type ParseOptions,
} from "./parser.ts";
export type { ImportRefValue as ImportRef } from "../schema/landofile-reference.ts";
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
  parseLegacyLandofile,
} from "./legacy/index.ts";
