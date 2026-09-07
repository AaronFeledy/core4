import { Context, type Effect } from "effect";
import type { ConfigTranslateError, ConfigTranslatorConflictError } from "../errors/config.ts";
import type { PluginLoadError } from "../errors/plugin.ts";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateEncodeInput,
  ConfigTranslateEncodeResult,
  ConfigTranslateInput,
  ConfigTranslateMatch,
  ConfigTranslateResult,
} from "../schema/config-translate.ts";

export type * from "../schema/config-translate.ts";

export interface ConfigTranslatorShape {
  readonly id: string;
  readonly summary: string;
  readonly inputKinds: ReadonlyArray<string>;
  readonly detect: (
    input: ConfigTranslateDetectInput,
  ) => Effect.Effect<ReadonlyArray<ConfigTranslateMatch>, ConfigTranslateError, never>;
  readonly translate: (
    input: ConfigTranslateInput,
  ) => Effect.Effect<ConfigTranslateResult, ConfigTranslateError, never>;
  readonly encode?: (
    input: ConfigTranslateEncodeInput,
  ) => Effect.Effect<ConfigTranslateEncodeResult, ConfigTranslateError, never>;
}

export class ConfigTranslator extends Context.Tag("@lando/core/ConfigTranslator")<
  ConfigTranslator,
  ConfigTranslatorShape
>() {}

/**
 * Registry of plugin-contributed config translators. `list` resolves every
 * `configTranslators:` contribution across the loaded plugin graph in plugin
 * order, invoking each lazy loader at most once. Duplicate ids fail with a
 * `ConfigTranslatorConflictError` naming both producing plugins; there is no
 * precedence winner. Nothing loads until `list` runs, so help, version,
 * ordinary loading, and tooling paths never construct translator factories.
 */
export interface ConfigTranslatorRegistryShape {
  readonly list: Effect.Effect<
    ReadonlyArray<ConfigTranslatorShape>,
    ConfigTranslatorConflictError | PluginLoadError,
    never
  >;
}

export class ConfigTranslatorRegistry extends Context.Tag("@lando/core/ConfigTranslatorRegistry")<
  ConfigTranslatorRegistry,
  ConfigTranslatorRegistryShape
>() {}
