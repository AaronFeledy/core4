// Shared file-format codec module (§10.13). One pure place to encode/decode the
// structured project-file formats that both `ManagedFileService` and the §6.4
// mount materializer consume, so structured encode and the Landofile round-trip
// exist exactly once.
//
// This module is deliberately PURE and dependency-light: it constructs no
// `LandoRuntime`, touches no filesystem, and imports neither an Effect runtime
// service nor `@oclif/core`. Its only edges are `effect` (for the `Effect`
// description type), the pure `@lando/sdk/landofile` serializer, and the
// `@lando/sdk` error/schema contracts. File I/O and atomic writes belong to the
// codec's consumers, never here.

import { Effect } from "effect";

import { ManagedFileError } from "@lando/sdk/errors";
import { LandofileEmitError, emitLandofileYaml, parseLandofile } from "@lando/sdk/landofile";
import type { FileFormat } from "@lando/sdk/schema";

/** The `ManagedFileService` operation a codec call is serving, used only to tag errors. */
export type ManagedFileOperation = "plan" | "apply" | "remove" | "status" | "adopt" | "release";

/** Options for {@link encode}. */
export interface EncodeOptions {
  /** Operation tag attached to any raised {@link ManagedFileError}. Defaults to `apply`. */
  readonly operation?: ManagedFileOperation;
}

/** Options for {@link decode}. */
export interface DecodeOptions {
  /** Operation tag attached to any raised {@link ManagedFileError}. Defaults to `plan`. */
  readonly operation?: ManagedFileOperation;
}

/** Options for {@link mergeManaged}. */
export interface MergeOptions {
  /** Operation tag attached to any raised {@link ManagedFileError}. Defaults to `apply`. */
  readonly operation?: ManagedFileOperation;
}

const DEFERRED_TO_4X = "Structured keys-mode merge is deferred to 4.x.";

const fail = (
  reason: ManagedFileError["reason"],
  operation: ManagedFileOperation,
  detail: { readonly remediation?: string; readonly cause?: unknown } = {},
): Effect.Effect<never, ManagedFileError> =>
  Effect.fail(
    new ManagedFileError({
      reason,
      operation,
      remediation: detail.remediation,
      cause: detail.cause,
    }),
  );

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// env (.env) codec — `KEY=value` lines.
// ---------------------------------------------------------------------------

const ENV_NEEDS_QUOTING = /[\s"#=\\]/u;

const quoteEnvValue = (value: string): string =>
  `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n")}"`;

const encodeEnv = (
  value: unknown,
  operation: ManagedFileOperation,
): Effect.Effect<string, ManagedFileError> => {
  if (!isPlainObject(value)) {
    return fail("format", operation, { remediation: "`env` content must be a key/value object." });
  }
  const lines: Array<string> = [];
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined || typeof raw === "object") {
      return fail("format", operation, {
        remediation: `\`env\` value for "${key}" must be a string, number, or boolean.`,
      });
    }
    const text = String(raw);
    lines.push(`${key}=${text === "" || ENV_NEEDS_QUOTING.test(text) ? quoteEnvValue(text) : text}`);
  }
  lines.push("");
  return Effect.succeed(lines.join("\n"));
};

const unquoteEnvValue = (raw: string): string => {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(.)/gu, (_, char: string) => (char === "n" ? "\n" : char));
  }
  return raw;
};

const decodeEnv = (text: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (match === null) continue;
    const [, key, value] = match as [string, string, string];
    result[key] = unquoteEnvValue(value);
  }
  return result;
};

// ---------------------------------------------------------------------------
// encode / decode / mergeManaged
// ---------------------------------------------------------------------------

/**
 * Encode a value for the declared {@link FileFormat}. `text` is written
 * verbatim, `json` is pretty-printed, `env` becomes `KEY=value` lines, and
 * `yaml`/`landofile` delegate to the canonical `@lando/sdk/landofile` serializer.
 * `toml`/`ini` are reserved and fail with `reason: "format"` until 4.x.
 */
export const encode = (
  format: FileFormat,
  value: unknown,
  opts: EncodeOptions = {},
): Effect.Effect<string, ManagedFileError> => {
  const operation = opts.operation ?? "apply";
  switch (format) {
    case "text":
      return typeof value === "string"
        ? Effect.succeed(value)
        : fail("format", operation, { remediation: "`text` content must be a string." });
    case "json":
      return Effect.try({
        try: () => `${JSON.stringify(value, null, 2)}\n`,
        catch: (cause) => new ManagedFileError({ reason: "format", operation, cause }),
      });
    case "env":
      return encodeEnv(value, operation);
    case "yaml":
    case "landofile":
      if (!isPlainObject(value)) {
        return fail("format", operation, {
          remediation: `\`${format}\` content must be an object.`,
        });
      }
      return Effect.try({
        try: () => emitLandofileYaml(value),
        catch: (cause) =>
          new ManagedFileError({
            reason: "format",
            operation,
            remediation: cause instanceof LandofileEmitError ? cause.message : undefined,
            cause,
          }),
      });
    case "toml":
    case "ini":
      return fail("format", operation, {
        remediation: `\`${format}\` encoding is deferred to 4.x.`,
      });
  }
};

/**
 * Decode existing on-disk content of the declared {@link FileFormat} back to a
 * structured value. `text` is returned verbatim, `json` is parsed, `env` is read
 * into a string map, and `yaml`/`landofile` delegate to the canonical
 * `@lando/sdk/landofile` parser. `toml`/`ini` are reserved until 4.x.
 */
export const decode = (
  format: FileFormat,
  text: string,
  opts: DecodeOptions = {},
): Effect.Effect<unknown, ManagedFileError> => {
  const operation = opts.operation ?? "plan";
  switch (format) {
    case "text":
      return Effect.succeed(text);
    case "json":
      return Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) => new ManagedFileError({ reason: "decode", operation, cause }),
      });
    case "env":
      return Effect.succeed(decodeEnv(text));
    case "yaml":
    case "landofile":
      return parseLandofile({ file: `<managed-file:${format}>`, content: text, cwd: "." }).pipe(
        Effect.mapError((cause) => new ManagedFileError({ reason: "decode", operation, cause })),
      );
    case "toml":
    case "ini":
      return fail("format", operation, {
        remediation: `\`${format}\` decoding is deferred to 4.x.`,
      });
  }
};

/**
 * Merge an owned structured subtree into existing content (the `keys` mode).
 * This is the 4.x structural-merge seam; for Beta 1 every format is stubbed to
 * fail with `reason: "format"` and a "deferred to 4.x" remediation, so callers
 * get a clear error rather than a silent no-op.
 */
export const mergeManaged = (
  _format: FileFormat,
  _existing: unknown,
  _ownedSubtree: unknown,
  _marker: string,
  opts: MergeOptions = {},
): Effect.Effect<string, ManagedFileError> =>
  fail("format", opts.operation ?? "apply", { remediation: DEFERRED_TO_4X });
