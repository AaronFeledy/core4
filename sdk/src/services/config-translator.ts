import { Context, type Effect } from "effect";
import type { ConfigTranslateError } from "../errors/config.ts";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateEncodeInput,
  ConfigTranslateEncodeResult,
  ConfigTranslateInput,
  ConfigTranslateMatch,
  ConfigTranslateResult,
} from "../schema/config-translate.ts";

// ==== Canonical schema-inferred data contracts
export type * from "../schema/config-translate.ts";

// ==== Pure translation port
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
