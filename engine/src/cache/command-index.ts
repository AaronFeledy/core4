import { deserialize, serialize } from "node:v8";
import { sha256Hex } from "@lando/sdk/digest";

import type { LandofileReferencedFile } from "@lando/landofile/load-expression-provenance";
import type { LandofileShape, ToolingInputDeclaration } from "@lando/sdk/schema";
import { canonicalCacheJson } from "./canonical.ts";
import { isAppCommandIndexPayload } from "./command-index-validation.ts";
import type { CommandScriptFingerprint } from "./command-script-freshness.ts";

import {
  type VersionConstraintEntry,
  getVersionConstraintEntries,
} from "@lando/landofile/version-constraint";

export const COMMAND_INDEX_SCHEMA_VERSION = 6n;

export const APP_COMMAND_MAGIC = new Uint8Array([0x4c, 0x43, 0x41, 0x43]);

export const COMMAND_INDEX_HEADER_BYTES = 12;
const VERSION_OFFSET = 4;

export interface CommandIndexEntry {
  readonly id: string;
  readonly summary: string;
  readonly hidden: boolean;
  readonly disabled?: true;
  readonly service?: string;
  readonly source?: "bun-script";
  readonly input?: ToolingInputDeclaration;
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
    disabled: [...new Set(policy.disabled ?? [])].sort(),
    custom: policy.custom ?? {},
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
  readonly sourceScripts?: readonly CommandScriptFingerprint[];
  readonly sourceMtimeMs: number;
  readonly sourceSize: number;
  readonly versionConstraints?: ReadonlyArray<VersionConstraintEntry>;
  readonly toolingFingerprint?: string;
  readonly entriesFingerprint?: string;
  readonly aliasPolicy?: CommandAliasPolicy;
  readonly generatedAtMs: number;
  readonly entries: ReadonlyArray<CommandIndexEntry>;
}

const stableFingerprint = (value: unknown): string => sha256Hex(canonicalCacheJson(value));

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

const decodePayload = (bytes: Uint8Array, magic: Uint8Array): unknown => {
  if (!headerMatches(bytes, magic)) return null;
  try {
    const payload: unknown = deserialize(bytes.subarray(COMMAND_INDEX_HEADER_BYTES));
    if (
      payload === null ||
      typeof payload !== "object" ||
      !Object.hasOwn(payload, "schemaVersion") ||
      !("schemaVersion" in payload) ||
      payload.schemaVersion !== Number(COMMAND_INDEX_SCHEMA_VERSION)
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

export const decodeAppCommandIndex = (bytes: Uint8Array): AppCommandIndexPayload | null => {
  const payload = decodePayload(bytes, APP_COMMAND_MAGIC);
  return isAppCommandIndexPayload(payload) ? payload : null;
};
