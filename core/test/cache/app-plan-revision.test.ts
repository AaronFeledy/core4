import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serialize } from "node:v8";

import { expect, test } from "bun:test";
import { DateTime, Effect, Schema } from "effect";

import { AbsolutePath, AppId, AppPlan, ProviderId, ServiceName } from "@lando/core/schema";
import {
  APP_PLAN_CACHE_HEADER_BYTES,
  APP_PLAN_CACHE_MAGIC,
  APP_PLAN_CACHE_SCHEMA_VERSION,
  deriveAppPlanCacheKey,
  readCachedAppPlan,
} from "../../src/cache/app-plan.ts";
import { appPlanCachePath } from "../../src/cache/paths.ts";
import { CORE_VERSION } from "../../src/version.ts";

test("rejects a valid app-plan cache encoded with revision 7", async () => {
  // Given
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-app-plan-v7-"));
  const appRoot = "/workspace/old-revision-app";
  const appName = "old-revision-app";
  const key = "revision-7-key";
  const serviceName = ServiceName.make("web");
  const metadata = {
    resolvedAt: DateTime.unsafeMake("2026-07-21T00:00:00Z"),
    source: `${appRoot}/.lando.yml`,
    runtime: 4 as const,
  };
  const oldPlan = Schema.encodeSync(AppPlan)({
    id: AppId.make(appName),
    name: appName,
    slug: appName,
    root: AbsolutePath.make(appRoot),
    provider: ProviderId.make("lando"),
    services: {
      [serviceName]: {
        name: serviceName,
        type: "apache",
        provider: ProviderId.make("lando"),
        primary: true,
        environment: {},
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  });
  const body = serialize({
    schemaVersion: 7,
    landoVersion: CORE_VERSION,
    key,
    versionConstraints: [],
    generatedAtMs: 1,
    plan: oldPlan,
  });
  const header = Buffer.alloc(APP_PLAN_CACHE_HEADER_BYTES);
  APP_PLAN_CACHE_MAGIC.copy(header, 0);
  header.writeBigUInt64BE(7n, 4);
  createHash("sha256").update(body).digest().copy(header, 12);
  const persisted = Buffer.concat([header, body]);
  const path = appPlanCachePath(cacheRoot, appName, appRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, persisted);

  // When
  const read = await Effect.runPromise(readCachedAppPlan({ cacheRoot, appName, appRoot, key }));

  // Then
  expect(read).toBeNull();
  expect(await readFile(path)).toEqual(persisted);
});

test("includes revision 8 in the app-plan cache key", () => {
  // Given
  const input = {
    appRoot: "/workspace/revision-key",
    landofile: { name: "revision-key", runtime: 4 as const },
    pluginManifests: [],
  };

  // When
  const key = deriveAppPlanCacheKey(input);

  // Then
  expect(APP_PLAN_CACHE_SCHEMA_VERSION).toBe(8n);
  expect(key).toBe("95c358e6662068b0268bb860ef348452e5b0e397d49ea4b383b5c982f410a805");
});
