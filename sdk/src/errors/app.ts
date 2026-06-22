import { Schema } from "effect";

/**
 * Resolution failure raised by the §16 App-handle resolver (`resolveApp` /
 * `runtime.app`). A single tagged error whose `reason` discriminates the
 * documented selector-validation outcomes:
 *
 * - `ambiguous`    — more than one usable selector field with no way to
 *                    validate the higher-precedence field against the lower.
 * - `mismatch`     — a higher-precedence field disagrees with a compatible
 *                    lower-precedence field (e.g. an explicit `id` that does
 *                    not match the Landofile at `root`).
 * - `missing-root` — a decoded `LandofileShape` selector was supplied without
 *                    the mandatory explicit `root`.
 * - `unknown-id`   — an `id` selector could not be resolved at the current
 *                    bootstrap level.
 * - `not-found`    — no Landofile could be discovered for the selector.
 */
export class AppResolveError extends Schema.TaggedError<AppResolveError>()("AppResolveError", {
  message: Schema.String,
  reason: Schema.Literal("ambiguous", "mismatch", "missing-root", "unknown-id", "not-found"),
  /** The selector field(s) involved in the failure, for diagnostics. */
  detail: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}
