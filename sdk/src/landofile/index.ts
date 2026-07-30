// `@lando/sdk/landofile` — canonical pure Landofile emit/parse (no Effect layers,
// filesystem, or CLI). `@lando/core/landofile` re-exports for in-tree writers.

export { emitLandofileYaml, emitLandofileYamlEither } from "./emit.ts";
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
