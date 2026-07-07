import { describe, expect, test } from "bun:test";

import {
  APP_COMMAND_MAGIC,
  COMMAND_INDEX_SCHEMA_VERSION,
  PLUGIN_COMMAND_MAGIC,
  decodeAppCommandIndex,
  decodePluginCommandIndex,
  encodeAppCommandIndex,
  encodePluginCommandIndex,
} from "../../src/cache/command-index.ts";

describe("encodeAppCommandIndex / decodeAppCommandIndex", () => {
  test("roundtrips an app command index payload", () => {
    const payload = {
      schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
      landoVersion: "0.0.0",
      appName: "myapp",
      sourceFile: "/tmp/test/.lando.yml",
      sourceMtimeMs: 1_700_000_000_000,
      sourceSize: 256,
      versionConstraints: [],
      generatedAtMs: 1_700_000_100_000,
      entries: [
        { id: "app:composer", summary: "Run Composer", hidden: false, service: "appserver" },
        { id: "app:test", summary: "Run tests", hidden: false },
      ],
    };

    const bytes = encodeAppCommandIndex(payload);
    const decoded = decodeAppCommandIndex(bytes);
    expect(decoded).toEqual(payload);
  });

  test("writes the app magic identifier and schema version at fixed offsets", () => {
    const payload = {
      schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
      landoVersion: "0.0.0",
      appName: "n",
      sourceFile: "/x/.lando.yml",
      sourceMtimeMs: 0,
      sourceSize: 0,
      versionConstraints: [],
      generatedAtMs: 0,
      entries: [],
    };

    const bytes = encodeAppCommandIndex(payload);
    expect(bytes.byteLength).toBeGreaterThan(12);
    for (let i = 0; i < APP_COMMAND_MAGIC.length; i++) {
      expect(bytes[i]).toBe(APP_COMMAND_MAGIC[i] as number);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getBigUint64(4, true)).toBe(COMMAND_INDEX_SCHEMA_VERSION);
  });

  test("decodeAppCommandIndex returns null for the plugin magic (cache type mismatch)", () => {
    const pluginBytes = encodePluginCommandIndex({
      schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
      landoVersion: "0.0.0",
      pluginNames: [],
      generatedAtMs: 0,
      entries: [],
    });
    expect(decodeAppCommandIndex(pluginBytes)).toBeNull();
  });

  test("decodeAppCommandIndex returns null for truncated bytes", () => {
    expect(decodeAppCommandIndex(new Uint8Array(0))).toBeNull();
    expect(decodeAppCommandIndex(new Uint8Array([0x4c, 0x43, 0x41, 0x43]))).toBeNull();
    expect(decodeAppCommandIndex(new Uint8Array([0x4c, 0x43, 0x41, 0x43, 1, 0, 0, 0]))).toBeNull();
  });

  test("decodeAppCommandIndex returns null for a wrong schema version", () => {
    const payload = {
      schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
      landoVersion: "0.0.0",
      appName: "n",
      sourceFile: "/x/.lando.yml",
      sourceMtimeMs: 0,
      sourceSize: 0,
      versionConstraints: [],
      generatedAtMs: 0,
      entries: [],
    };
    const bytes = encodeAppCommandIndex(payload);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(4, 999n, true);
    expect(decodeAppCommandIndex(bytes)).toBeNull();
  });
});

describe("encodePluginCommandIndex / decodePluginCommandIndex", () => {
  test("roundtrips a plugin command index payload", () => {
    const payload = {
      schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
      landoVersion: "0.0.0",
      pluginNames: ["@lando/provider-lando", "@lando/service-lando"],
      pluginListSha: "a".repeat(64),
      commandsByPlugin: {
        "@lando/provider-lando": ["meta:setup"],
        "@lando/service-lando": ["meta:service:list"],
      },
      generatedAtMs: 1_700_000_000_000,
      entries: [
        { id: "meta:plugin:add", summary: "", hidden: false },
        { id: "meta:plugin:remove", summary: "", hidden: false },
      ],
    };
    const bytes = encodePluginCommandIndex(payload);
    expect(decodePluginCommandIndex(bytes)).toEqual(payload);
  });

  test("writes the plugin magic identifier at the file head", () => {
    const bytes = encodePluginCommandIndex({
      schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
      landoVersion: "0.0.0",
      pluginNames: [],
      generatedAtMs: 0,
      entries: [],
    });
    for (let i = 0; i < PLUGIN_COMMAND_MAGIC.length; i++) {
      expect(bytes[i]).toBe(PLUGIN_COMMAND_MAGIC[i] as number);
    }
  });

  test("decodePluginCommandIndex returns null for the app magic (cache type mismatch)", () => {
    const appBytes = encodeAppCommandIndex({
      schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
      landoVersion: "0.0.0",
      appName: "n",
      sourceFile: "/x/.lando.yml",
      sourceMtimeMs: 0,
      sourceSize: 0,
      versionConstraints: [],
      generatedAtMs: 0,
      entries: [],
    });
    expect(decodePluginCommandIndex(appBytes)).toBeNull();
  });
});
