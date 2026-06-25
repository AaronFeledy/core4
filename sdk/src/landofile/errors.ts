import { Schema } from "effect";

/**
 * The tagged error raised by the canonical Landofile emitter when a value
 * cannot be serialized to the block-style Landofile subset (for example, an
 * invalid map key, a non-finite number, an unsupported value type, a symbol
 * key, a cyclic structure, or a nested array list item).
 *
 * It rides the `@lando/sdk/landofile` subpath rather than the frozen
 * `@lando/sdk/errors` barrel — mirroring where `@lando/sdk/template` places its
 * `TemplateCompileError`/`TemplateRenderError` — so the canonical serializer can
 * evolve its error surface without touching the compatibility-locked barrel.
 */
export class LandofileEmitError extends Schema.TaggedError<LandofileEmitError>()("LandofileEmitError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
