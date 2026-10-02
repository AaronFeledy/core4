import { posix } from "node:path";
import { SchemaIssue } from "effect";
import { Effect } from "effect";

import { Schema, SchemaTransformation } from "effect";

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
  Schema.check(
    Schema.makeFilter((id) => id.length > 0, {
      message: "A log source id must not be empty.",
    }),
  ),
  Schema.check(
    Schema.makeFilter((id) => id !== RESERVED_LOG_SOURCE_ID, {
      message: "`console` is a reserved log source id and cannot be declared.",
    }),
  ),
  Schema.brand("LogSourceId"),
);
export type LogSourceId = typeof LogSourceId.Type;

/** Render/exit classification of a source's lines (not container provenance). */
export const LogSourceStream = Schema.Literals(["stdout", "stderr"]);
export type LogSourceStream = typeof LogSourceStream.Type;

/** How a declared source is reified: build-time redirect, or a runtime follower. */
export const LogSourceStrategy = Schema.Literals(["redirect", "follow"]);
export type LogSourceStrategy = typeof LogSourceStrategy.Type;

/**
 * A declared log source — a statement that a service also produces logs at an
 * in-container file path, plus how Lando should surface them.
 */
export const LogSource = Schema.Struct({
  /** Unique within the service; `console` is reserved. */
  id: LogSourceId.annotate({
    description: "Unique source id within the service; `console` is reserved for the implicit engine stream.",
  }),
  /** Human-facing label, e.g. "apache error log". */
  label: Schema.optionalKey(Schema.String).annotate({
    description: "Human-readable label shown when presenting this log source.",
  }),
  /** Single in-container file (no globs). */
  path: AbsolutePath.annotate({
    description: "Single absolute in-container file path for this log source; globs are not supported.",
  }),
  /** Render/exit classification of this source's lines. */
  stream: LogSourceStream.annotate({
    description: "Render and exit classification for this source's lines.",
  }),
  /** How the source is reified: build-time redirect, or a runtime follower. */
  strategy: LogSourceStrategy.annotate({
    description: "How Lando reifies the declared source: build-time redirect or runtime follower.",
  }),
  /** When true, an unavailable source fails planning instead of degrading. */
  required: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => false))).annotate({
    description: "Whether an unavailable source fails planning instead of degrading.",
  }),
  /** When true, lines carry parseable leading timestamps, enabling `--since`. */
  timestamps: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => false))).annotate({
    description: "Whether lines carry parseable leading timestamps so `--since` filtering can apply.",
  }),
});
export type LogSource = typeof LogSource.Type;

/** The Landofile-facing input shape for a user-declared source. */
const LogSourceInputFields = Schema.Struct({
  /** Single in-container file path (required). */
  path: AbsolutePath.annotate({
    description: "Single absolute in-container file path declared under `services.<name>.logs`.",
  }),
  /** Human-facing label. */
  label: Schema.optionalKey(Schema.String).annotate({
    description: "Optional human-readable label for this Landofile log source.",
  }),
  /** Render/exit classification; defaults to stderr. */
  stream: LogSourceStream.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => "stderr" as const))).annotate({
    description: "Render and exit classification for this source's lines; defaults to stderr.",
  }),
  /** Source id; defaults to the path basename. */
  id: Schema.optionalKey(LogSourceId).annotate({
    description: "Optional source id; defaults to the path basename.",
  }),
});

/**
 * `LogSourceInput` is the Landofile-facing shape (`services.<name>.logs:`).
 * Decoding yields a full {@link LogSource}: user-declared sources always resolve
 * to `strategy: "follow"` (Lando does not own a user's arbitrary image build)
 * and `timestamps: false`; the id defaults to the path basename.
 */
export const LogSourceInput = LogSourceInputFields.pipe(
  Schema.decodeTo(
    LogSource,
    SchemaTransformation.transformEffect<typeof LogSource.Encoded, typeof LogSourceInputFields.Type>({
      decode: (input) =>
        Effect.succeed({
          id: input.id ?? posix.basename(input.path),
          ...(input.label === undefined ? {} : { label: input.label }),
          path: input.path,
          stream: input.stream,
          strategy: "follow" as const,
          required: false,
          timestamps: false,
        }),
      encode: (source: typeof LogSource.Encoded) => {
        if (source.strategy !== "follow" || source.required !== false || source.timestamps !== false) {
          return Effect.fail(
            new SchemaIssue.InvalidValue(
              {
                message:
                  "Landofile log source input can only encode follow sources with required=false and timestamps=false.",
              },
              source,
            ),
          );
        }

        return Effect.succeed({
          path: AbsolutePath.make(source.path),
          ...(source.label === undefined ? {} : { label: source.label }),
          stream: source.stream,
          id: LogSourceId.make(source.id),
        });
      },
    }),
  ),
);
export type LogSourceInput = typeof LogSourceInput.Type;
