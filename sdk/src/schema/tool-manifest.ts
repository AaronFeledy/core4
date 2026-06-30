import { Schema } from "effect";

/**
 * A single pinned artifact entry for a tool the provisioning helper installs as
 * a host binary. One canonical shape replaces bespoke per-plugin versions-manifest
 * entry shapes (e.g. the old `mutagen-versions.json` `host`/`agents` entries).
 *
 * `member` is an archive-member selector that may cross exactly one nested
 * supported-archive boundary (e.g. `mutagen-agents.tar.gz/linux_amd64`); an
 * omitted `archive` means the downloaded bytes are the binary itself.
 */
export const ToolArtifactEntry = Schema.Struct({
  url: Schema.String,
  sha256: Schema.String,
  sizeBytes: Schema.optional(Schema.Number),
  archive: Schema.optional(Schema.Literal("tar.gz", "zip")),
  member: Schema.optional(Schema.String),
  installName: Schema.String,
  mode: Schema.optional(Schema.String),
});
export type ToolArtifactEntry = typeof ToolArtifactEntry.Type;

/**
 * Multi-platform pinned manifest for a tool that installs one or more host
 * binaries under `<userDataRoot>/bin/`. `artifacts` is keyed by a caller-defined
 * artifact key (e.g. `${platform}-${arch}` for a single-binary tool, or a
 * structured key like `linux-x64/cli` / `linux-x64/agent/linux-amd64` when a
 * tool installs several binaries from the same pinned release).
 */
export const ToolManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  toolVersion: Schema.String,
  artifacts: Schema.Record({ key: Schema.String, value: ToolArtifactEntry }),
});
export type ToolManifest = typeof ToolManifest.Type;
