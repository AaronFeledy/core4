// `@lando/sdk/landofile` — canonical pure Landofile emit/parse (no Effect layers,
// filesystem, or CLI). `@lando/core/landofile` re-exports for in-tree writers.

export {
  emitLandofileYaml,
  emitLandofileYamlEither,
  LANDOFILE_LEADING_COMMENT_BLOCKS,
  type LandofileLeadingCommentBlock,
} from "./emit.ts";
export {
  declaredConfigTranslateSourceIds,
  validateConfigTranslateInput,
  validateConfigTranslateResult,
} from "./config-translate.ts";
export { LandofileEmitError } from "./errors.ts";
export {
  detectLandofileTags,
  type LandofileTag,
  type LandofileTagOccurrence,
  type LoadHint,
  parseLandofile,
  type ParseOptions,
} from "./parser.ts";
export type { ImportRefValue as ImportRef } from "../schema/landofile-reference.ts";
