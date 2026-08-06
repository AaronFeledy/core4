// Canonical Landofile YAML parser (`!load`/`!import`) lives in `@lando/sdk/landofile`.
// Re-export for existing in-tree callers.
export {
  detectLandofileTags,
  type ImportRef,
  type LandofileTag,
  type LandofileTagOccurrence,
  type LoadHint,
  parseLandofile,
  type ParseOptions,
} from "@lando/sdk/landofile";
