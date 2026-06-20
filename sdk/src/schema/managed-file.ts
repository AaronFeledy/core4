import { Schema } from "effect";

import { AbsolutePath, PortablePath } from "./primitives.ts";

// Managed-file primitive shapes — the declarative model `ManagedFileService`
// plans and applies against the user's working tree. A caller
// supplies one or more `ManagedFile` entries describing rendered, marked
// project files the user can adopt (settings.php, .env, a Landofile fragment);
// the service renders content, encodes structured formats, applies ownership
// markers, records a ledger, and never silently clobbers a user edit.

/**
 * Encoding of a managed file. `text` is written verbatim; `env`/`json`/`yaml`/
 * `landofile` round-trip structured content through the shared codec module;
 * `toml`/`ini` are reserved and fail with a `format` remediation until 4.x.
 */
export const FileFormat = Schema.Literal("text", "env", "json", "yaml", "toml", "ini", "landofile");
export type FileFormat = typeof FileFormat.Type;

const TextContentSource = Schema.Struct({
  kind: Schema.Literal("text"),
  /** Already-rendered string, encoded as-is for the declared `format`. */
  value: Schema.String,
});

const StructuredContentSource = Schema.Struct({
  kind: Schema.Literal("structured"),
  /** JSON-like data encoded by the shared codec for `env`/`json`/`yaml`/`landofile`. */
  data: Schema.Unknown,
});

const TemplateContentSource = Schema.Struct({
  kind: Schema.Literal("template"),
  /** Template file (relative to base) rendered through `TemplateRenderer` before encode. */
  file: PortablePath,
  /** Variables passed to the template renderer. */
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

const InlineContentSource = Schema.Struct({
  kind: Schema.Literal("inline"),
  /** Inline template string rendered through `TemplateRenderer` before encode. */
  template: Schema.String,
  /** Variables passed to the template renderer. */
  vars: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});

/**
 * Where a managed file's bytes come from. A four-member tagged union:
 * `text` (verbatim), `structured` (codec-encoded data), `template` (a template
 * file rendered before encode), and `inline` (an inline template string).
 */
export const ContentSource = Schema.Union(
  TextContentSource,
  StructuredContentSource,
  TemplateContentSource,
  InlineContentSource,
);
export type ContentSource = typeof ContentSource.Type;

/**
 * One declarative managed-file entry. `mode: "file"` owns the whole file with a
 * top-of-file ownership marker; `mode: "block"` owns only a fenced region in a
 * user-owned file; `mode: "keys"` reserves a structured subtree (4.x consumer).
 */
export const ManagedFile = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  path: PortablePath,
  mode: Schema.Literal("file", "block", "keys"),
  format: FileFormat,
  content: ContentSource,
  marker: Schema.optional(Schema.String),
  perms: Schema.optional(Schema.String),
  onConflict: Schema.optional(Schema.Literal("skip", "overwrite", "fail")),
  base: Schema.optional(AbsolutePath),
});
export type ManagedFile = typeof ManagedFile.Type;

/**
 * The per-file decision produced by `plan` and reported by `apply`: a new file
 * (`create`), an in-place rewrite (`update`), a no-op (`skip-unchanged`), a
 * pre-existing/adopted user file left alone (`skip-adopted`), a protected
 * in-place user edit (`conflict`), or a marker-removed file recorded as adopted
 * (`adopt-detected`).
 */
export const ManagedFileAction = Schema.Literal(
  "create",
  "update",
  "skip-unchanged",
  "skip-adopted",
  "conflict",
  "adopt-detected",
);
export type ManagedFileAction = typeof ManagedFileAction.Type;

/**
 * The side-effect-free output of `plan(files)`: the action the service would
 * take for each requested managed file, without touching the working tree.
 */
export const ManagedFilePlan = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: PortablePath,
      action: ManagedFileAction,
    }),
  ),
});
export type ManagedFilePlan = typeof ManagedFilePlan.Type;

/**
 * Status of a single managed/adopted file in the working tree, surfaced by
 * `status` and consumed by `lando doctor`.
 */
export const ManagedFileInfo = Schema.Struct({
  path: PortablePath,
  owner: Schema.String,
  mode: Schema.Literal("file", "block", "keys"),
  state: Schema.Literal("managed", "adopted", "conflict", "missing", "drifted"),
});
export type ManagedFileInfo = typeof ManagedFileInfo.Type;

/**
 * What `apply`/`remove` actually did: the action taken for each managed file
 * plus the backup path written when a conflict was overwritten.
 */
export const ManagedFileResult = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: PortablePath,
      action: ManagedFileAction,
      backup: Schema.optional(PortablePath),
    }),
  ),
});
export type ManagedFileResult = typeof ManagedFileResult.Type;
