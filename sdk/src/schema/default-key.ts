import { Effect, Schema, SchemaGetter } from "effect";

/**
 * Optional struct key with a decoding default that also publishes `default`
 * into JSON Schema (Effect emits it as an annotation-only `allOf` member).
 *
 * Prefer this over {@link Schema.withDecodingDefaultKey} for fields reachable
 * from `GlobalConfig` or `LandofileShape` so describers and schema-reference
 * docs can surface the default. `value` must be a JSON value matching the
 * schema's Encoded form; it is `structuredClone`d on each missing-key decode.
 * Pass the field `description` here: an annotation added after the pipe lands
 * only on the decoded side and never reaches the published JSON Schema.
 */
export const withDefaultKey =
  <S extends Schema.Top>(value: S["Encoded"] & Schema.Json, annotations?: { readonly description: string }) =>
  (self: S) =>
    Schema.optionalKey(Schema.toEncoded(self))
      .annotateKey({ ...annotations, default: value })
      .pipe(
        Schema.decodeTo(self, {
          decode: SchemaGetter.withDefault(Effect.sync((): S["Encoded"] => structuredClone(value))),
          encode: SchemaGetter.passthrough(),
        }),
      )
      .annotate(annotations ?? {});
