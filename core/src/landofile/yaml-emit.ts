// The canonical block-style Landofile serializer now lives in the pure
// `@lando/sdk/landofile` subpath (§7.8.1), so the emit/parse round-trip exists
// exactly once. This module re-exports it for the existing in-tree callers.
export { emitLandofileYaml, emitLandofileYamlEither } from "@lando/sdk/landofile";
