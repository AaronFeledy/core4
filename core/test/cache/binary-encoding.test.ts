import { type BinaryLike, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deserialize, serialize } from "node:v8";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/core/schema";
import type { CacheService } from "@lando/core/services";
import {
  APP_PLAN_CACHE_HEADER_BYTES,
  APP_PLAN_CACHE_MAGIC,
  APP_PLAN_CACHE_SCHEMA_VERSION,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../../src/cache/app-plan.ts";
import {
  APP_COMMAND_MAGIC,
  COMMAND_INDEX_HEADER_BYTES,
  COMMAND_INDEX_SCHEMA_VERSION,
  PLUGIN_COMMAND_MAGIC,
  decodeAppCommandIndex,
  decodePluginCommandIndex,
  encodeAppCommandIndex,
  encodePluginCommandIndex,
} from "../../src/cache/command-index.ts";
import {
  CWD_APP_MAP_CACHE_FILE,
  CWD_APP_MAP_CACHE_HEADER_BYTES,
  CWD_APP_MAP_CACHE_MAGIC,
  CWD_APP_MAP_CACHE_SCHEMA_VERSION,
  listCwdAppMapEntries,
  writeCwdAppMapEntry,
} from "../../src/cache/cwd-app-map.ts";
import { appPlanCachePath } from "../../src/cache/paths.ts";
import { CacheServiceLive } from "../../src/cache/service.ts";

const fixtureRoot = resolve(import.meta.dirname, "fixtures", "binary-cache");

const appCommandPayload = {
  schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
  landoVersion: "0.0.0",
  appName: "fixture-app",
  sourceFile: "/workspace/fixture-app/.lando.yml",
  sourceMtimeMs: 1_700_000_000_000,
  sourceSize: 128,
  generatedAtMs: 1_700_000_100_000,
  entries: [{ id: "fixture:task", summary: "Fixture task", hidden: false, service: "appserver" }],
};

const pluginCommandPayload = {
  schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
  landoVersion: "0.0.0",
  pluginNames: ["@lando/fixture"],
  generatedAtMs: 1_700_000_200_000,
  entries: [{ id: "meta:fixture", summary: "Fixture plugin command", hidden: false }],
};

const appPlanFixture: AppPlan = {
  id: AppId.make("fixture-app"),
  name: "fixture-app",
  slug: "fixture-app",
  root: AbsolutePath.make("/workspace/fixture-app"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-05-20T00:00:00Z"),
    source: "/workspace/fixture-app/.lando.yml",
    runtime: 4,
  },
  extensions: {},
};

const sha256 = (payload: BinaryLike): Buffer => createHash("sha256").update(payload).digest();

const expectMagic = (bytes: Uint8Array, magic: Uint8Array): void => {
  for (let i = 0; i < magic.byteLength; i++) {
    expect(bytes[i]).toBe(magic[i] as number);
  }
};

const writeWithCache = <A>(effect: Effect.Effect<A, unknown, CacheService>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(CacheServiceLive)));

const makeAppPlanBytes = async (): Promise<Buffer> => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-fixture-"));
  const path = await writeWithCache(
    writeCachedAppPlan({
      cacheRoot,
      appName: "fixture-app",
      appRoot: "/workspace/fixture-app",
      key: "fixture-key",
      plan: appPlanFixture,
      now: () => 1_700_000_300_000,
    }),
  );
  return readFile(path);
};

const makeCwdAppMapBytes = async (): Promise<Buffer> => {
  const cacheRoot = join(tmpdir(), `lando-cwd-app-map-fixture-${crypto.randomUUID()}`);
  await Effect.runPromise(
    writeCwdAppMapEntry({
      cacheRoot,
      entry: {
        cwd: "/workspace/fixture-app/subdir",
        appRoot: "/workspace/fixture-app",
        primaryLandofilePath: "/workspace/fixture-app/.lando.yml",
        mtimeNs: 1,
        sizeBytes: 128,
        lastUsedAt: 1_700_000_400_000,
      },
    }),
  );
  return readFile(join(cacheRoot, CWD_APP_MAP_CACHE_FILE));
};

const makeFixtureBytes = async (name: string): Promise<Buffer> => {
  switch (name) {
    case "app-command":
      return Buffer.from(encodeAppCommandIndex(appCommandPayload));
    case "plugin-command":
      return Buffer.from(encodePluginCommandIndex(pluginCommandPayload));
    case "app-plan":
      return makeAppPlanBytes();
    case "cwd-app-map":
      return makeCwdAppMapBytes();
    default:
      throw new Error(`Unknown fixture ${name}`);
  }
};

describe("binary cache encoding policy", () => {
  const commandCases = [
    {
      name: "app-command",
      magic: APP_COMMAND_MAGIC,
      version: COMMAND_INDEX_SCHEMA_VERSION,
      fixture: "app-command-v1.bin",
      decode: decodeAppCommandIndex,
    },
    {
      name: "plugin-command",
      magic: PLUGIN_COMMAND_MAGIC,
      version: COMMAND_INDEX_SCHEMA_VERSION,
      fixture: "plugin-command-v1.bin",
      decode: decodePluginCommandIndex,
    },
  ] as const;

  for (const cache of commandCases) {
    test(`${cache.name} fixture matches the encoder output`, async () => {
      const encoded = await makeFixtureBytes(cache.name);
      const fixture = await readFile(join(fixtureRoot, cache.fixture));
      expect(encoded).toEqual(fixture);
    });

    test(`${cache.name} writes magic and schema version in the binary header`, async () => {
      const bytes = await makeFixtureBytes(cache.name);
      expectMagic(bytes, cache.magic);
      expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(4, true)).toBe(
        cache.version,
      );
      expect(cache.decode(bytes)).not.toBeNull();
    });

    test(`${cache.name} ignores unknown header and payload schema versions`, async () => {
      const bytes = Buffer.from(await makeFixtureBytes(cache.name));
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(4, 999n, true);
      expect(cache.decode(bytes)).toBeNull();

      const original = cache.decode(await makeFixtureBytes(cache.name));
      expect(original).not.toBeNull();
      const rewritten = Buffer.concat([
        Buffer.from((await makeFixtureBytes(cache.name)).subarray(0, COMMAND_INDEX_HEADER_BYTES)),
        serialize({ ...original, schemaVersion: 999 }),
      ]);
      expect(cache.decode(rewritten)).toBeNull();
    });
  }

  test("app-plan fixture matches the encoder output", async () => {
    expect(await makeAppPlanBytes()).toEqual(await readFile(join(fixtureRoot, "app-plan-v2.bin")));
  });

  test("app-plan writes magic, schema version, and payload checksum in the binary header", async () => {
    const bytes = await makeAppPlanBytes();
    expectMagic(bytes, APP_PLAN_CACHE_MAGIC);
    expect(Buffer.from(bytes).readBigUInt64BE(4)).toBe(APP_PLAN_CACHE_SCHEMA_VERSION);
    expect(Array.from(Buffer.from(bytes).subarray(12, APP_PLAN_CACHE_HEADER_BYTES))).toEqual(
      Array.from(sha256(bytes.subarray(APP_PLAN_CACHE_HEADER_BYTES))),
    );
  });

  test("app-plan ignores unknown header and payload schema versions", async () => {
    const cacheRoot = join(tmpdir(), `lando-app-plan-version-${crypto.randomUUID()}`);
    const path = appPlanCachePath(cacheRoot, "fixture-app", "/workspace/fixture-app");

    const unknownHeader = Buffer.from(await makeAppPlanBytes());
    unknownHeader.writeBigUInt64BE(999n, 4);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, unknownHeader);
    expect(
      await Effect.runPromise(
        readCachedAppPlan({
          cacheRoot,
          appName: "fixture-app",
          appRoot: "/workspace/fixture-app",
          key: "fixture-key",
        }),
      ),
    ).toBeNull();

    const payloadVersion = Buffer.from(await makeAppPlanBytes());
    const body = Buffer.from(
      serialize({ ...deserialize(payloadVersion.subarray(APP_PLAN_CACHE_HEADER_BYTES)), schemaVersion: 999 }),
    );
    const header = Buffer.from(payloadVersion.subarray(0, APP_PLAN_CACHE_HEADER_BYTES));
    sha256(body).copy(header, 12);
    await writeFile(path, Buffer.concat([header, body]));
    expect(
      await Effect.runPromise(
        readCachedAppPlan({
          cacheRoot,
          appName: "fixture-app",
          appRoot: "/workspace/fixture-app",
          key: "fixture-key",
        }),
      ),
    ).toBeNull();
  });

  test("cwd-app-map fixture matches the encoder output", async () => {
    expect(await makeCwdAppMapBytes()).toEqual(await readFile(join(fixtureRoot, "cwd-app-map-v1.bin")));
  });

  test("cwd-app-map writes magic, schema version, and payload checksum in the binary header", async () => {
    const bytes = await makeCwdAppMapBytes();
    expectMagic(bytes, CWD_APP_MAP_CACHE_MAGIC);
    expect(Buffer.from(bytes).readBigUInt64BE(4)).toBe(CWD_APP_MAP_CACHE_SCHEMA_VERSION);
    expect(Array.from(Buffer.from(bytes).subarray(12, CWD_APP_MAP_CACHE_HEADER_BYTES))).toEqual(
      Array.from(sha256(bytes.subarray(CWD_APP_MAP_CACHE_HEADER_BYTES))),
    );
  });

  test("cwd-app-map ignores unknown header schema versions", async () => {
    const cacheRoot = join(tmpdir(), `lando-cwd-app-map-version-${crypto.randomUUID()}`);
    const path = join(cacheRoot, CWD_APP_MAP_CACHE_FILE);
    const bytes = Buffer.from(await makeCwdAppMapBytes());
    bytes.writeBigUInt64BE(999n, 4);
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(path, bytes);

    expect(await Effect.runPromise(listCwdAppMapEntries(cacheRoot))).toEqual([]);
  });
});
