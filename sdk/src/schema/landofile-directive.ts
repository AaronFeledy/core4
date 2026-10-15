import { Schema } from "effect";

/** Shared brand distinguishing native operations from user-authored mappings. */
export const LANDOFILE_MERGE_DIRECTIVE = Symbol.for("@lando/sdk/landofile/merge-directive");

/** Describe a native replacement operation whose payload is validated by the supplied schema. */
export const LandofileOverride = <S extends Schema.Top>(value: S) =>
  Schema.Struct({ [LANDOFILE_MERGE_DIRECTIVE]: Schema.Literal("override"), value }).annotate({
    identifier: "LandofileOverride",
    title: "Native Landofile override",
    description: "Replaces an inherited mapping member with its native authoring payload.",
  });
export type LandofileOverride<T> = ReturnType<typeof LandofileOverride<Schema.Codec<T>>>["Type"];

export const LandofileReset = Schema.Struct({
  [LANDOFILE_MERGE_DIRECTIVE]: Schema.Literal("reset"),
}).annotate({
  identifier: "LandofileReset",
  title: "Native Landofile reset",
  description: "Removes an inherited mapping member during layer composition.",
});
export type LandofileReset = typeof LandofileReset.Type;

/** Describe the JSON transport envelope for a replacement operation. */
export const LandofileOverrideWire = <S extends Schema.Top>(value: S) =>
  Schema.Struct({ _tag: Schema.Literal("LandofileOverride"), value }).annotate({
    identifier: "LandofileOverrideWire",
    title: "Landofile override envelope",
    description: "Transports a replacement payload; decode to a native directive before emission.",
  });
export const LandofileResetWire = Schema.Struct({ _tag: Schema.Literal("LandofileReset") }).annotate({
  identifier: "LandofileResetWire",
  title: "Landofile reset envelope",
  description: "Transports a removal operation; decode to a native directive before emission.",
});

export const LandofileLiteralWire = Schema.Struct({
  _tag: Schema.Literal("LandofileLiteral"),
  value: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({
  identifier: "LandofileLiteralWire",
  title: "Literal Landofile mapping",
  description: "Escapes opaque mappings that resemble reserved transport envelopes.",
});
