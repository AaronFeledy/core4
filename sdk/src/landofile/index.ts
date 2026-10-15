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
export { decodeLandofileLayer, type LandofileLayerValidator } from "./layer-decode.ts";
export { decodeLandofileAuthoringLayer } from "./authoring-layer-decode.ts";
export {
  override,
  reset,
  isLandofileOverride,
  isLandofileReset,
  isMergeDirective,
} from "./merge-directives.ts";
export {
  LandofileOverride,
  LandofileReset,
  LANDOFILE_MERGE_DIRECTIVE,
} from "../schema/landofile-directive.ts";
export type { LandofileOverlayInput, LandofileDecodedOverlay } from "../schema/landofile-overlay.ts";
export { splitComposeCommand, type SplitCommand } from "./compose-command.ts";
export { LANDOFILE_LAYER_ORDER, landofileLayerRank } from "./layer-order.ts";
export {
  type RouteFilterIdentity,
  isPlainRecord,
  mergeLandofiles,
  mergeValues,
  routeFilterIdentity,
  routeFilterMatches,
} from "./overlay-merge.ts";
export { resolveLayerMergeRule } from "./layer-merge-rules.ts";
export { assertLayerMergeCompleteness, listLayerMergeRules } from "./layer-merge-trie.ts";
export {
  parseRouteShorthand,
  routeMatchKey,
  routeInputObject,
  routeInputKey,
  expandRouteSchemes,
} from "./route-input.ts";
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
