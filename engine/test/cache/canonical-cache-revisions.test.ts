import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serialize } from "node:v8";
import { AbsolutePath, AppId, AppPlan, ProviderId } from "@lando/sdk/schema";
import { DateTime, Effect, Schema } from "effect";
import { readCachedAppPlan } from "../../src/cache/app-plan.ts";
import {
  readFreshAppCommandCacheForCwd,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import { decodeAppCommandIndex, decodePluginCommandIndex } from "../../src/cache/command-index.ts";
import { appPlanCachePath, appToolingCompilationCachePath } from "../../src/cache/paths.ts";
import { CORE_VERSION } from "../../src/version.ts";

test("rejects a valid revision-17 persisted plan even when its cache key matches", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-canonical-plan-"));
  try {
    const appRoot = "/workspace/canonical-app";
    const appName = "canonical-app";
    const key = "matching-key";
    const plan: AppPlan = {
      id: AppId.make(appName),
      name: appName,
      slug: appName,
      root: AbsolutePath.make(appRoot),
      provider: ProviderId.make("lando"),
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      metadata: {
        resolvedAt: DateTime.makeUnsafe("2026-10-02T00:00:00Z"),
        source: `${appRoot}/.lando.yml`,
        runtime: 4,
      },
      extensions: {},
    };
    const body = serialize({
      schemaVersion: 17,
      landoVersion: CORE_VERSION,
      key,
      versionConstraints: [],
      generatedAtMs: 1,
      plan: Schema.encodeSync(AppPlan)(plan),
    });
    const header = Buffer.alloc(44);
    header.write("LCAP");
    header.writeBigUInt64BE(17n, 4);
    createHash("sha256").update(body).digest().copy(header, 12);
    const path = appPlanCachePath(cacheRoot, appName, appRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.concat([header, body]));
    const cached = await Effect.runPromise(readCachedAppPlan({ cacheRoot, appName, appRoot, key }));
    expect(cached).toBeNull();
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

for (const magic of ["LCAC", "LCPC"]) {
  test(`rejects revision-3 ${magic} bytes when the old payload is otherwise valid`, () => {
    const header = Buffer.alloc(12);
    header.write(magic);
    header.writeBigUInt64LE(3n, 4);
    const bytes = Buffer.concat([
      header,
      serialize({
        schemaVersion: 3,
        landoVersion: CORE_VERSION,
        appName: "app",
        sourceFile: "/app/.lando.yml",
        sourceMtimeMs: 0,
        sourceSize: 0,
        pluginNames: [],
        generatedAtMs: 1,
        entries: [],
      }),
    ]);
    const decoded = magic === "LCAC" ? decodeAppCommandIndex(bytes) : decodePluginCommandIndex(bytes);
    expect(decoded).toBeNull();
  });
}

test("fresh command reader rejects revision-3 artifacts without recomputing fingerprints", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-canonical-command-"));
  try {
    const appRoot = join(cacheRoot, "app");
    await mkdir(appRoot);
    await writeFile(join(appRoot, ".lando.yml"), "name: app\n");
    const entries = [{ id: "app:hello", summary: "Hello", hidden: false }];
    await Effect.runPromise(
      writeAppCommandCacheStrict({ cwd: appRoot, cacheRoot, landofile: { name: "app" }, entries }),
    );
    const current = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));
    expect(current?.entries).toEqual(entries);
    const path = appToolingCompilationCachePath(cacheRoot, appRoot);
    const currentBytes = await readFile(path);
    if (current === null) throw new TypeError("Current command cache must roundtrip");
    const oldPayload = { ...current, schemaVersion: 3 };
    const header = Buffer.from(currentBytes.subarray(0, 12));
    header.writeBigUInt64LE(3n, 4);
    await writeFile(path, Buffer.concat([header, serialize(oldPayload)]));
    const old = await Effect.runPromise(readFreshAppCommandCacheForCwd({ cwd: appRoot, cacheRoot }));
    expect(old).toBeNull();
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
