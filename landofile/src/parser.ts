// Canonical Landofile YAML parser (`!load`/`!import`) lives in `@lando/sdk/landofile`.
// Re-export for existing in-tree callers.
export {
  type ImportRef,
  type LandofileTag,
  type LandofileTagOccurrence,
  type LoadHint,
  type ParseOptions,
  detectLandofileTags,
  parseLandofile,
} from "@lando/sdk/landofile";
