import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";

import type { LandofileReferencedFile } from "@lando/landofile/load-expression-provenance";
import type { LandofileShape, PluginManifest } from "@lando/sdk/schema";

import {
  type VersionConstraintEntry,
  getVersionConstraintEntries,
} from "@lando/landofile/version-constraint";

export const COMMAND_INDEX_SCHEMA_VERSION = 2n;

export const APP_COMMAND_MAGIC = new Uint8Array([0x4c, 0x43, 0x41, 0x43]);

export const PLUGIN_COMMAND_MAGIC = new Uint8Array([0x4c, 0x43, 0x50, 0x43]);

export const COMMAND_INDEX_HEADER_BYTES = 12;
const VERSION_OFFSET = 4;

export interface CommandIndexEntry {
  readonly id: string;
  readonly summary: string;
  readonly hidden: boolean;
  readonly service?: string;
  readonly source?: "bun-script";
}

interface CommandAliasPolicy {
  readonly enabled: boolean;
  readonly disabled: ReadonlyArray<string>;
  readonly custom: Readonly<Record<string, string>>;
}

export const normalizeAppCommandAliasPolicy = (landofile: LandofileShape): CommandAliasPolicy | undefined => {
  const policy = landofile.commandAliases;
  if (policy === undefined) return undefined;
  return {
    enabled: policy.enabled ?? true,
    disabled: [...new Set(policy.disabled ?? [])].sort((left, right) => left.localeCompare(right)),
    custom: Object.fromEntries(
      Object.entries(policy.custom ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
};

export interface AppCommandIndexPayload {
  readonly schemaVersion: number;
  readonly landoVersion: string;
  readonly appName: string;
  readonly sourceFile: string;
  readonly sourceContentHash?: string;
  readonly sourceLocalIncludePaths?: ReadonlyArray<string>;
  readonly sourceReferencedFiles?: ReadonlyArray<LandofileReferencedFile>;
  readonly sourceMtimeMs: number;
  readonly sourceSize: number;
  readonly versionConstraints?: ReadonlyArray<VersionConstraintEntry>;
  readonly toolingFingerprint?: string;
  readonly entriesFingerprint?: string;
  readonly aliasPolicy?: CommandAliasPolicy;
  readonly generatedAtMs: number;
  readonly entries: ReadonlyArray<CommandIndexEntry>;
}

export interface PluginCommandIndexPayload {
  readonly schemaVersion: number;
  readonly landoVersion: string;
  readonly pluginNames: ReadonlyArray<string>;
  readonly pluginListSha?: string;
  readonly commandsByPlugin?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly manifestFingerprint?: string;
  readonly generatedAtMs: number;
  readonly entries: ReadonlyArray<CommandIndexEntry>;
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
};

const stableFingerprint = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");

const normalizeManifest = (manifest: PluginManifest) => ({
  name: manifest.name,
  version: manifest.version,
  api: manifest.api,
  enabled: manifest.enabled ?? true,
  bundled: manifest.bundled ?? false,
  contributes: manifest.contributes ?? {},
});

export const derivePluginCommandManifestFingerprint = (manifests: ReadonlyArray<PluginManifest>): string =>
  stableFingerprint(
    manifests
      .map(normalizeManifest)
      .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.api - b.api),
  );

export const derivePluginCommandPluginListSha = (manifests: ReadonlyArray<PluginManifest>): string =>
  stableFingerprint(
    manifests
      .map((manifest) => ({ name: manifest.name, version: manifest.version, api: manifest.api }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.api - b.api),
  );

export const derivePluginCommandIdsByPlugin = (
  manifests: ReadonlyArray<PluginManifest>,
): Readonly<Record<string, ReadonlyArray<string>>> =>
  Object.fromEntries(
    manifests
      .map(
        (manifest) =>
          [
            manifest.name,
            [...(manifest.contributes?.commands ?? [])]
              .map((entry) => (typeof entry === "string" ? entry : entry.id))
              .sort((a, b) => a.localeCompare(b)),
          ] as const,
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );

export const deriveAppCommandToolingFingerprint = (landofile: LandofileShape): string =>
  stableFingerprint({
    services: landofile.services ?? null,
    tooling: landofile.tooling ?? null,
    toolingDefaults: landofile.toolingDefaults ?? null,
    commandAliases: landofile.commandAliases ?? null,
    includes: landofile.includes ?? null,
    versionConstraints: getVersionConstraintEntries(landofile, ".lando.yml"),
  });

export const deriveAppCommandEntriesFingerprint = (entries: ReadonlyArray<CommandIndexEntry>): string =>
  stableFingerprint(entries);

const encodePayload = (magic: Uint8Array, payload: unknown): Uint8Array => {
  const header = new Uint8Array(COMMAND_INDEX_HEADER_BYTES);
  header.set(magic, 0);
  new DataView(header.buffer).setBigUint64(VERSION_OFFSET, COMMAND_INDEX_SCHEMA_VERSION, true);
  const body = new Uint8Array(serialize(payload));
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header, 0);
  bytes.set(body, header.byteLength);
  return bytes;
};

const headerMatches = (bytes: Uint8Array, magic: Uint8Array): boolean => {
  if (bytes.byteLength <= COMMAND_INDEX_HEADER_BYTES) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(VERSION_OFFSET, true) === COMMAND_INDEX_SCHEMA_VERSION;
};

const decodePayload = <T>(bytes: Uint8Array, magic: Uint8Array): T | null => {
  if (!headerMatches(bytes, magic)) return null;
  try {
    const payload = deserialize(bytes.subarray(COMMAND_INDEX_HEADER_BYTES)) as T;
    if (
      payload === null ||
      typeof payload !== "object" ||
      (payload as { schemaVersion?: unknown }).schemaVersion !== Number(COMMAND_INDEX_SCHEMA_VERSION)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};

export const encodeAppCommandIndex = (payload: AppCommandIndexPayload): Uint8Array =>
  encodePayload(APP_COMMAND_MAGIC, payload);

export const decodeAppCommandIndex = (bytes: Uint8Array): AppCommandIndexPayload | null =>
  decodePayload<AppCommandIndexPayload>(bytes, APP_COMMAND_MAGIC);

export const encodePluginCommandIndex = (payload: PluginCommandIndexPayload): Uint8Array =>
  encodePayload(PLUGIN_COMMAND_MAGIC, payload);

export const decodePluginCommandIndex = (bytes: Uint8Array): PluginCommandIndexPayload | null =>
  decodePayload<PluginCommandIndexPayload>(bytes, PLUGIN_COMMAND_MAGIC);
