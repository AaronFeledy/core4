// `@lando/sdk/landofile` — the one canonical, pure, dependency-light Landofile
// serializer pair (§7.8.1). It mirrors `@lando/sdk/expressions`/`@lando/sdk/template`:
// pure logic with no Effect Layers, no Bun runtime services, no filesystem, and
// no `@oclif/core`. `@lando/core/landofile` re-exports this subpath for cold-path
// writers, config-translator plugins, and embedding hosts.

export { emitLandofileYaml, emitLandofileYamlEither } from "./emit.ts";
export { LandofileEmitError } from "./errors.ts";
export { type ImportRef, type LoadHint, parseLandofile, type ParseOptions } from "./parser.ts";
