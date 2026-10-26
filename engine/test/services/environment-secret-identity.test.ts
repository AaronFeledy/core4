import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serialize } from "node:v8";
import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";
import { AbsolutePath, AppId, AppPlan, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Schema } from "effect";
import {
  APP_PLAN_CACHE_HEADER_BYTES,
  APP_PLAN_CACHE_MAGIC,
  readCachedAppPlan,
  writeCachedAppPlan,
} from "../../src/cache/app-plan.ts";
import { appPlanCachePath } from "../../src/cache/paths.ts";
import * as AppCacheService from "../../src/cache/service.ts";
import { makePluginStateStore } from "../../src/plugins/context-state.ts";
import { appBuildKeyForStep, buildKeyForService } from "../../src/services/build-key.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { CORE_VERSION } from "../../src/version.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("test"),
  primary: true,
  environment: { TOKEN: { _tag: "SecretRef", reference: "TEST" } },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  valueModel: 1,
  id: AppId.make("identity"),
  name: "identity",
  slug: "identity",
  root: AbsolutePath.make("/tmp/identity"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test("separates active and literal environment bytes in build identities", async () => {
  // Given
  const literal = { ...service, environment: { TOKEN: "${secret:TEST}" } };
  // When
  const keys = await Effect.runPromise(
    Effect.all([
      buildKeyForService(TestRuntimeProvider, service),
      buildKeyForService(TestRuntimeProvider, literal),
    ]),
  );
  // Then
  expect(keys[0]).not.toBe(keys[1]);
  expect(appBuildKeyForStep({ command: ["true"], service, stepId: "app" })).not.toBe(
    appBuildKeyForStep({ command: ["true"], service: literal, stepId: "app" }),
  );
});

test("roundtrips bindings through binary cache and misses revision 27", async () => {
  // Given
  const cacheRoot = await mkdtemp(join(tmpdir(), "lando-binding-cache-"));
  try {
    const path = await Effect.runPromise(
      writeCachedAppPlan({ cacheRoot, appName: "identity", appRoot: plan.root, key: "current", plan }).pipe(
        Effect.provide(AppCacheService.layer),
      ),
    );
    const current = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "identity", appRoot: plan.root, key: "current" }),
    );
    const body = serialize({
      schemaVersion: 27,
      landoVersion: CORE_VERSION,
      key: "old",
      versionConstraints: [],
      shadowHostChecks: [],
      gitHostChecks: [],
      generatedAtMs: 1,
      plan: Schema.encodeSync(AppPlan)(plan),
    });
    const header = Buffer.alloc(APP_PLAN_CACHE_HEADER_BYTES);
    APP_PLAN_CACHE_MAGIC.copy(header, 0);
    header.writeBigUInt64BE(27n, 4);
    createHash("sha256").update(body).digest().copy(header, 12);
    const oldPath = appPlanCachePath(cacheRoot, "old", plan.root);
    await mkdir(dirname(oldPath), { recursive: true });
    await writeFile(oldPath, Buffer.concat([header, body]));
    // When
    const old = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot, appName: "old", appRoot: plan.root, key: "old" }),
    );
    // Then
    expect(path).toBe(appPlanCachePath(cacheRoot, "identity", plan.root));
    expect(current?.services[service.name]?.environment.TOKEN).toEqual({
      _tag: "SecretRef",
      reference: "TEST",
    });
    expect(old).toBeNull();
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("roundtrips bindings through applied state", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-binding-applied-"));
  try {
    const stateStore = makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make(root),
      ownerOnlyFileAccess,
    );
    const store = makeAppliedPlanStore({ providerId: "lando", layout: "per-app" });
    // When
    await Effect.runPromise(store.persistAppliedPlan(stateStore, plan));
    const loaded = await Effect.runPromise(store.loadAppliedPlan(stateStore, plan.id));
    // Then
    expect(loaded?.services[service.name]?.environment.TOKEN).toEqual({
      _tag: "SecretRef",
      reference: "TEST",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("misses an unmarked plan even in the current cache revision", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-unmarked-cache-"));
  const { valueModel: _marker, ...historical } = plan;
  try {
    await Effect.runPromise(
      writeCachedAppPlan({
        cacheRoot: root,
        appName: "historical",
        appRoot: plan.root,
        key: "same",
        plan: historical,
      }).pipe(Effect.provide(AppCacheService.layer)),
    );
    // When
    const loaded = await Effect.runPromise(
      readCachedAppPlan({ cacheRoot: root, appName: "historical", appRoot: plan.root, key: "same" }),
    );
    // Then
    expect(loaded).toBeNull();
    expect(historical).not.toHaveProperty("valueModel");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
