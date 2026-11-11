// `@lando/sdk/landofile` — canonical pure Landofile emit/parse (no Effect layers,
// filesystem, or CLI). `@lando/core/landofile` re-exports for in-tree writers.

export {
  LANDOFILE_MERGE_DIRECTIVE,
  LandofileOverride,
  LandofileReset,
} from "../schema/landofile-directive.ts";
export { encodeLandofileSourceValue } from "../schema/landofile-directive-codec.ts";
export type { LandofileDecodedOverlay, LandofileOverlayInput } from "../schema/landofile-overlay.ts";
export type { ImportRefValue as ImportRef } from "../schema/landofile-reference.ts";
export { decodeLandofileAuthoringLayer } from "./authoring-layer-decode.ts";
export { type SplitCommand, splitComposeCommand } from "./compose-command.ts";
export {
  type ComposeDisposition,
  type ComposeDispositionEntry,
  ComposeDispositionMatrixError,
  composeDispositionFor,
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "./compose-dispositions.ts";
export {
  compareKeyPaths,
  declaredConfigTranslateSourceIds,
  validateConfigTranslateInput,
  validateConfigTranslateResult,
} from "./config-translate.ts";
export { directivePathProblem } from "./directive-paths.ts";
export {
  LANDOFILE_LEADING_COMMENT_BLOCKS,
  type LandofileLeadingCommentBlock,
  emitLandofileYaml,
  emitLandofileYamlEither,
} from "./emit.ts";
export { LandofileEmitError } from "./errors.ts";
export {
  type FlowMappingRemediationOptions,
  GENERIC_FLOW_MAPPING_REMEDIATION,
  flowMappingRemediation,
} from "./flow-mapping-remediation.ts";
export { type LandofileLayerValidator, decodeLandofileLayer } from "./layer-decode.ts";
export { resolveLayerMergeRule } from "./layer-merge-rules.ts";
export { assertLayerMergeCompleteness, listLayerMergeRules } from "./layer-merge-trie.ts";
export { LANDOFILE_LAYER_ORDER, landofileLayerRank } from "./layer-order.ts";
export {
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
  type LegacyTagOccurrence,
  type LegacyTagged,
  type LegacyTree,
  isLegacyTagged,
  parseLegacyLandofile,
} from "./legacy/index.ts";
export {
  isLandofileOverride,
  isLandofileReset,
  isMergeDirective,
  override,
  reset,
} from "./merge-directives.ts";
export {
  type RouteFilterIdentity,
  isPlainRecord,
  mergeLandofiles,
  mergeValues,
  mergeValuesWithOrigins,
  routeFilterIdentity,
  routeFilterMatches,
} from "./overlay-merge.ts";
export {
  type ValueOrigins,
  type ValueWithOrigins,
  valueOriginAt,
  withValueOrigins,
} from "./overlay-origins.ts";
export {
  type LandofileTag,
  type LandofileTagOccurrence,
  type LoadHint,
  type ParseOptions,
  detectLandofileTags,
  parseLandofile,
} from "./parser.ts";
export {
  expandRouteSchemes,
  parseRouteHostname,
  parseRoutePathPrefix,
  parseRouteShorthand,
  routeInputKey,
  routeInputObject,
  routeMatchKey,
} from "./route-input.ts";
