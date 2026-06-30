#!/usr/bin/env bun
/**
 * Regenerate `plugins/file-sync-mutagen/mutagen-versions.json` as a canonical
 * `ToolManifest` from the pinned upstream tag in
 * `plugins/file-sync-mutagen/mutagen-version`.
 *
 * Inputs:
 *   - `plugins/file-sync-mutagen/mutagen-version` (one-line pinned upstream tag)
 *   - `MUTAGEN_CHECKSUMS` (pinned per-tag SHA-256 + size table below)
 *
 * Output:
 *   - `plugins/file-sync-mutagen/mutagen-versions.json` (validated against the
 *     SDK `ToolManifest` schema, consumed at runtime by the tool-provisioning
 *     helper)
 *
 * Drift gate: re-run + `git diff --exit-code` on the output. The manifest is
 * byte-stable for a given pinned upstream tag.
 *
 * Artifact-key scheme (one binary per key): `<hostKey>/cli` installs the host
 * CLI; `<hostKey>/agent/<guest>` installs a per-platform agent extracted from
 * the host archive's nested `mutagen-agents.tar.gz` via the single-boundary
 * nested-member selector. Agent entries reuse the host archive's url/sha256 so
 * the byte cache de-duplicates the one download across host + agents.
 */
import { resolve } from "node:path";

import { Schema } from "effect";

import { ToolManifest } from "@lando/sdk/schema";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLUGIN_ROOT = resolve(REPO_ROOT, "plugins/file-sync-mutagen");
const VERSION_FILE = resolve(PLUGIN_ROOT, "mutagen-version");
const OUTPUT = resolve(PLUGIN_ROOT, "mutagen-versions.json");

const RELEASE_BASE = "https://github.com/mutagen-io/mutagen/releases/download";

/** Host targets: manifest hostKey -> upstream archive descriptor. */
const HOST_TARGETS = [
  { hostKey: "darwin-x64", slug: "darwin_amd64", ext: "tar.gz", cli: "mutagen" },
  { hostKey: "darwin-arm64", slug: "darwin_arm64", ext: "tar.gz", cli: "mutagen" },
  { hostKey: "linux-x64", slug: "linux_amd64", ext: "tar.gz", cli: "mutagen" },
  { hostKey: "linux-arm64", slug: "linux_arm64", ext: "tar.gz", cli: "mutagen" },
  { hostKey: "win32-x64", slug: "windows_amd64", ext: "zip", cli: "mutagen.exe" },
] as const;

/** Guest agents installed alongside every host (extracted from the nested agents tarball). */
const GUEST_AGENTS = [
  { guest: "linux-amd64", member: "linux_amd64" },
  { guest: "linux-arm64", member: "linux_arm64" },
  { guest: "linux-armv7", member: "linux_arm" },
] as const;

/**
 * Pinned per-tag upstream archive SHA-256 + size, keyed by archive slug. These
 * are the published upstream release checksums for the pinned tag; bumping the
 * tag adds a new block here.
 */
const MUTAGEN_CHECKSUMS: Record<string, Record<string, { sha256: string; sizeBytes: number }>> = {
  "v0.18.1": {
    darwin_amd64: {
      sha256: "7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf",
      sizeBytes: 102340208,
    },
    darwin_arm64: {
      sha256: "6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2",
      sizeBytes: 101929802,
    },
    linux_amd64: {
      sha256: "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
      sizeBytes: 102172827,
    },
    linux_arm64: {
      sha256: "bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a",
      sizeBytes: 101769445,
    },
    windows_amd64: {
      sha256: "76f8223d5e6b607efdd9516473669ae5492e4f142887352d59bc6934d1f07a2d",
      sizeBytes: 102206512,
    },
  },
};

const readPinnedVersion = async (): Promise<string> => {
  const raw = (await Bun.file(VERSION_FILE).text()).trim();
  if (!/^v\d+\.\d+\.\d+$/u.test(raw)) {
    throw new Error(`Invalid pinned Mutagen version "${raw}" in ${VERSION_FILE}; expected e.g. v0.18.1.`);
  }
  return raw;
};

const archiveUrl = (version: string, slug: string, ext: string): string =>
  `${RELEASE_BASE}/${version}/mutagen_${slug}_${version}.${ext}`;

const buildManifest = (version: string): typeof ToolManifest.Type => {
  const checksums = MUTAGEN_CHECKSUMS[version];
  if (checksums === undefined) {
    throw new Error(
      `No pinned checksums for Mutagen ${version}; add a MUTAGEN_CHECKSUMS["${version}"] block.`,
    );
  }
  const artifacts: Record<string, (typeof ToolManifest.Type.artifacts)[string]> = {};

  for (const host of HOST_TARGETS) {
    const checksum = checksums[host.slug];
    if (checksum === undefined) {
      throw new Error(`Missing pinned checksum for ${host.slug} at Mutagen ${version}.`);
    }
    const url = archiveUrl(version, host.slug, host.ext);

    artifacts[`${host.hostKey}/cli`] = {
      url,
      sha256: checksum.sha256,
      sizeBytes: checksum.sizeBytes,
      archive: host.ext === "zip" ? "zip" : "tar.gz",
      member: host.cli,
      installName: host.cli,
    };

    for (const agent of GUEST_AGENTS) {
      artifacts[`${host.hostKey}/agent/${agent.guest}`] = {
        url,
        sha256: checksum.sha256,
        sizeBytes: checksum.sizeBytes,
        archive: host.ext === "zip" ? "zip" : "tar.gz",
        member: `mutagen-agents.tar.gz/${agent.member}`,
        installName: `mutagen-agents/mutagen-agent-${agent.guest}`,
      };
    }
  }

  return { schemaVersion: 1, toolVersion: version, artifacts };
};

const main = async (): Promise<void> => {
  const version = await readPinnedVersion();
  const manifest = buildManifest(version);
  // Validate against the canonical schema before writing.
  Schema.decodeUnknownSync(ToolManifest)(manifest);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await Bun.write(OUTPUT, json);
  console.log(
    `[build-mutagen-versions] wrote ${OUTPUT} (${version}, ${Object.keys(manifest.artifacts).length} artifacts)`,
  );
};

await main();
