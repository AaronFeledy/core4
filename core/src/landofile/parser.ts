// Canonical Landofile YAML parser (`!load`/`!import`) lives in `@lando/sdk/landofile`.
// Re-export for existing in-tree callers.
export { type ImportRef, type LoadHint, parseLandofile, type ParseOptions } from "@lando/sdk/landofile";
