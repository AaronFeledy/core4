import { Schema } from "effect";

export const LANDOFILE_MERGE_DIRECTIVE = Symbol.for("@lando/sdk/landofile/merge-directive");

export const LandofileOverride = <S extends Schema.Top>(value: S) =>
  Schema.Struct({ [LANDOFILE_MERGE_DIRECTIVE]: Schema.Literal("override"), value });
export type LandofileOverride<T> = ReturnType<typeof LandofileOverride<Schema.Codec<T>>>["Type"];

export const LandofileReset = Schema.Struct({ [LANDOFILE_MERGE_DIRECTIVE]: Schema.Literal("reset") });
export type LandofileReset = typeof LandofileReset.Type;

export const LandofileOverrideWire = <S extends Schema.Top>(value: S) =>
  Schema.Struct({ _tag: Schema.Literal("LandofileOverride"), value });
export const LandofileResetWire = Schema.Struct({ _tag: Schema.Literal("LandofileReset") });
