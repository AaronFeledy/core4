import { describe, expect, test } from "bun:test";

import { type LandofileShape, PortablePath, ToolingInputRevision } from "@lando/sdk/schema";

import {
  APP_COMMAND_MAGIC,
  type AppCommandIndexPayload,
  COMMAND_INDEX_SCHEMA_VERSION,
  decodeAppCommandIndex,
  deriveAppCommandToolingFingerprint,
  encodeAppCommandIndex,
} from "../../src/cache/command-index.ts";

describe("encodeAppCommandIndex / decodeAppCommandIndex", () => {
  test("uses version ten for unavailable task metadata", () => {
    // Given / When / Then
    expect(COMMAND_INDEX_SCHEMA_VERSION).toBe(11n);
  });

  test.each([2n, 3n, 4n, 5n, 6n])(
    "returns a cache miss for an old payload with header %s",
    (headerVersion) => {
      // Given
      const bytes = encodeAppCommandIndex({
        schemaVersion: Number(headerVersion),
        landoVersion: "0.0.0",
        appName: "old",
        sourceFile: "/app/.lando.yml",
        sourceMtimeMs: 0,
        sourceSize: 0,
        generatedAtMs: 0,
        entries: [],
      });
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(4, headerVersion, true);
      // When
      const decoded = decodeAppCommandIndex(bytes);
      // Then
      expect(decoded).toBeNull();
    },
  );

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
        {
          id: "app:composer",
          summary: "Run Composer",
          _tag: "Ready" as const,
          sourceKind: "tooling" as const,
          visibility: "public" as const,
          input: emptyToolingInput,
          service: "appserver",
        },
        {
          id: "app:test",
          summary: "Run tests",
          _tag: "Ready" as const,
          sourceKind: "tooling" as const,
          visibility: "public" as const,
          input: {
            flags: [
              {
                name: "name",
                alias: "n",
                boolean: false,
                default: "world",
                required: false,
                sensitive: false,
              },
            ],
            args: [{ name: "target", order: 0, choices: ["dev", "prod"], required: true, sensitive: false }],
            acceptsArguments: true,
            revision: ToolingInputRevision.make("fixture-revision"),
          },
        },
      ],
    } satisfies AppCommandIndexPayload;

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

  test("decodeAppCommandIndex returns null for a non-app magic (cache type mismatch)", () => {
    const bytes = encodeAppCommandIndex({
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
    // Flip first magic byte so the header no longer matches APP_COMMAND_MAGIC.
    const wrong = new Uint8Array(bytes);
    wrong[0] = 0x00;
    expect(decodeAppCommandIndex(wrong)).toBeNull();
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

describe("deriveAppCommandToolingFingerprint", () => {
  const baseLandofile = {
    name: "myapp",
    tooling: { hello: { cmd: "echo hi" } },
  } satisfies LandofileShape;

  test("changes when only toolingDefaults is added or removed", () => {
    // Given
    const withoutDefaults = baseLandofile;
    const withDefaults = {
      ...baseLandofile,
      toolingDefaults: { service: "appserver", dir: PortablePath.make("/app") },
    } satisfies LandofileShape;

    // When
    const noDefaultsFingerprint = deriveAppCommandToolingFingerprint(withoutDefaults);
    const defaultsFingerprint = deriveAppCommandToolingFingerprint(withDefaults);
    const restoredFingerprint = deriveAppCommandToolingFingerprint(withoutDefaults);

    // Then
    expect(defaultsFingerprint).not.toBe(noDefaultsFingerprint);
    expect(restoredFingerprint).toBe(noDefaultsFingerprint);
  });

  test("is stable across toolingDefaults property insertion order", () => {
    // Given
    const first: LandofileShape = {
      ...baseLandofile,
      toolingDefaults: {
        service: "appserver",
        env: { A: "1", B: "2" },
        dir: PortablePath.make("/app"),
      },
    };
    const second: LandofileShape = {
      ...baseLandofile,
      toolingDefaults: {
        dir: PortablePath.make("/app"),
        env: { B: "2", A: "1" },
        service: "appserver",
      },
    };

    // When / Then
    expect(deriveAppCommandToolingFingerprint(first)).toBe(deriveAppCommandToolingFingerprint(second));
  });
});

import { normalizeToolingInput as fixtureToolingInput } from "@lando/landofile/tooling-input-normalize";
import { Result as FixtureResult } from "effect";

const emptyToolingInput = FixtureResult.getOrThrowWith(fixtureToolingInput("fixture", {}), (error) => error);
