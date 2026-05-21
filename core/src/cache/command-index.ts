import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";

import type { LandofileShape, PluginManifest } from "@lando/sdk/schema";

export const COMMAND_INDEX_SCHEMA_VERSION = 1n;

export const APP_COMMAND_MAGIC = new Uint8Array([0x4c, 0x43, 0x41, 0x43]);

export const PLUGIN_COMMAND_MAGIC = new Uint8Array([0x4c, 0x43, 0x50, 0x43]);

export const COMMAND_INDEX_HEADER_BYTES = 12;
const VERSION_OFFSET = 4;

export interface CommandIndexEntry {
  readonly id: string;
  readonly summary: string;
  readonly hidden: boolean;
  readonly service?: string;
}

export interface AppCommandIndexPayload {
  readonly schemaVersion: number;
  readonly landoVersion: string;
  readonly appName: string;
  readonly sourceFile: string;
  readonly sourceMtimeMs: number;
  readonly sourceSize: number;
  readonly toolingFingerprint?: string;
  readonly entriesFingerprint?: string;
  readonly generatedAtMs: number;
  readonly entries: ReadonlyArray<CommandIndexEntry>;
}

export interface PluginCommandIndexPayload {
  readonly schemaVersion: number;
  readonly landoVersion: string;
  readonly pluginNames: ReadonlyArray<string>;
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

export const deriveAppCommandToolingFingerprint = (landofile: LandofileShape): string =>
  stableFingerprint({ tooling: landofile.tooling ?? null });

export const deriveAppCommandEntriesFingerprint = (entries: ReadonlyArray<CommandIndexEntry>): string =>
  stableFingerprint(entries);

const writeHeader = (magic: Uint8Array): Uint8Array => {
  const header = new Uint8Array(COMMAND_INDEX_HEADER_BYTES);
  header.set(magic, 0);
  new DataView(header.buffer).setBigUint64(VERSION_OFFSET, COMMAND_INDEX_SCHEMA_VERSION, true);
  return header;
};

const concat = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
  const out = new Uint8Array(head.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(tail, head.byteLength);
  return out;
};

const encodePayload = (magic: Uint8Array, payload: unknown): Uint8Array => {
  const body = new Uint8Array(serialize(payload));
  return concat(writeHeader(magic), body);
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
