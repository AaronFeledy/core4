import { posix } from "node:path";

import { Schema } from "effect";

import { AbsolutePath } from "./primitives.ts";

/**
 * The implicit source id backing every service's native engine log stream.
 * It is never declared explicitly; a declared source using it is rejected.
 */
export const RESERVED_LOG_SOURCE_ID = "console";

/**
 * Branded id for a declared log source, unique within a service. The implicit
 * `console` source is reserved and cannot be used by a declared source, so the
 * brand rejects it (and empty ids) at decode time.
 */
export const LogSourceId = Schema.String.pipe(
  Schema.filter((id) => id.length > 0, {
    message: () => "A log source id must not be empty.",
  }),
  Schema.filter((id) => id !== RESERVED_LOG_SOURCE_ID, {
    message: () => "`console` is a reserved log source id and cannot be declared.",
  }),
  Schema.brand("LogSourceId"),
);
export type LogSourceId = typeof LogSourceId.Type;

/** Render/exit classification of a source's lines (not container provenance). */
export const LogSourceStream = Schema.Literal("stdout", "stderr");
export type LogSourceStream = typeof LogSourceStream.Type;

/** How a declared source is reified: build-time redirect, or a runtime follower. */
export const LogSourceStrategy = Schema.Literal("redirect", "follow");
export type LogSourceStrategy = typeof LogSourceStrategy.Type;

/**
 * A declared log source — a statement that a service also produces logs at an
 * in-container file path, plus how Lando should surface them (§6.14.1).
 */
export const LogSource = Schema.Struct({
  /** Unique within the service; `console` is reserved. */
  id: LogSourceId,
  /** Human-facing label, e.g. "apache error log". */
  label: Schema.optional(Schema.String),
  /** Single in-container file (no globs in v4.0). */
  path: AbsolutePath,
  /** Render/exit classification of this source's lines. */
  stream: LogSourceStream,
  /** How the source is reified (§6.14.3). */
  strategy: LogSourceStrategy,
  /** When true, an unavailable source fails planning instead of degrading. */
  required: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** When true, lines carry parseable leading timestamps, enabling `--since`. */
  timestamps: Schema.optionalWith(Schema.Boolean, { default: () => false }),
});
export type LogSource = typeof LogSource.Type;

/** The Landofile-facing input shape for a user-declared source. */
const LogSourceInputFields = Schema.Struct({
  /** Single in-container file path (required). */
  path: AbsolutePath,
  /** Human-facing label. */
  label: Schema.optional(Schema.String),
  /** Render/exit classification; defaults to stderr. */
  stream: Schema.optionalWith(LogSourceStream, { default: () => "stderr" as const }),
  /** Source id; defaults to the path basename. */
  id: Schema.optional(LogSourceId),
});

/**
 * `LogSourceInput` is the Landofile-facing shape (`services.<name>.logs:`).
 * Decoding yields a full {@link LogSource}: user-declared sources always resolve
 * to `strategy: "follow"` (Lando does not own a user's arbitrary image build)
 * and `timestamps: false`; the id defaults to the path basename.
 */
export const LogSourceInput = Schema.transform(LogSourceInputFields, LogSource, {
  strict: true,
  decode: (input) => ({
    id: input.id ?? posix.basename(input.path),
    ...(input.label === undefined ? {} : { label: input.label }),
    path: input.path,
    stream: input.stream,
    strategy: "follow" as const,
    required: false,
    timestamps: false,
  }),
  encode: (_encoded, source) => ({
    path: source.path,
    ...(source.label === undefined ? {} : { label: source.label }),
    stream: source.stream,
    id: source.id,
  }),
});
export type LogSourceInput = typeof LogSourceInput.Type;
