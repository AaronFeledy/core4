import { Context, type Effect } from "effect";

import type { ConfigTranslateError } from "../errors/index.ts";
import type { AbsolutePath, LandofileShape, PortablePath } from "../schema/index.ts";

export type LandofileFragment = Partial<LandofileShape>;

export type ConfigTranslateConfidence = "exact" | "likely" | "possible";

export type ConfigTranslateDiagnosticKind = "generated" | "unsupported" | "non-portable" | "needs-review";

export interface ConfigTranslateDiagnostic {
  readonly kind: ConfigTranslateDiagnosticKind;
  readonly message: string;
  readonly path?: string;
}

export interface ConfigTranslateDetectInput {
  readonly appRoot: AbsolutePath;
  readonly files?: ReadonlyArray<PortablePath>;
}

export interface ConfigTranslateMatch {
  readonly translator: string;
  readonly files: ReadonlyArray<PortablePath>;
  readonly confidence: ConfigTranslateConfidence;
  readonly summary?: string;
}

export interface ConfigTranslateInput {
  readonly appRoot: AbsolutePath;
  readonly files: ReadonlyArray<PortablePath>;
  readonly current: LandofileShape;
  readonly options: Record<string, unknown>;
}

export interface ConfigTranslateResult {
  readonly fragment: LandofileFragment;
  readonly diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>;
}

export interface ConfigTranslatorShape {
  readonly id: string;
  readonly summary: string;
  readonly inputKinds: ReadonlyArray<string>;
  readonly detect: (
    input: ConfigTranslateDetectInput,
  ) => Effect.Effect<ReadonlyArray<ConfigTranslateMatch>, ConfigTranslateError>;
  readonly translate: (
    input: ConfigTranslateInput,
  ) => Effect.Effect<ConfigTranslateResult, ConfigTranslateError>;
}

export class ConfigTranslator extends Context.Tag("@lando/core/ConfigTranslator")<
  ConfigTranslator,
  ConfigTranslatorShape
>() {}
