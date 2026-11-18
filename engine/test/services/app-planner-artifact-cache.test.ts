import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as AppPlanCache from "../../src/cache/app-plan.ts";
import { APP_PLAN_CACHE_HEADER_BYTES, writeCachedAppPlan } from "../../src/cache/app-plan.ts";
import { appPlanCachePath } from "../../src/cache/paths.ts";
import * as Cache from "../../src/cache/service.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { buildKeyForService } from "../../src/services/build-key.ts";
import * as FileSystem from "../../src/services/file-system.ts";
import * as Planner from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

test("#2122 replans a cached service that predates the artifact requirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-artifact-cache-"));
  const cacheRoot = join(root, "cache");
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  const name = "artifact-cache";
  const web = ServiceName.make("web");
  const document = literalTestLandofile(
    {
      name,
      runtime: 4,
      services: { [web]: { type: "compose", image: "nginx:alpine", home: false } },
    },
    root,
  );
  const layer = Planner.layer.pipe(
    Layer.provide(Layer.mergeAll(Cache.layer, Registry.layer, FileSystem.layer)),
  );
  const plan = () =>
    Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(document, TestRuntimeProvider.capabilities)).pipe(
        Effect.provide(layer),
      ),
    );
  try {
    const first = await plan();
    const service = first.services[web];
    if (service === undefined) throw new TypeError("Expected web service");
    const { artifact: _artifact, ...withoutArtifact } = service;
    const bytes = await readFile(appPlanCachePath(cacheRoot, name, root));
    const payload = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
      deserialize(bytes.subarray(APP_PLAN_CACHE_HEADER_BYTES)),
    );
    await Effect.runPromise(
      writeCachedAppPlan({
        cacheRoot,
        appName: name,
        appRoot: root,
        key: payload.key,
        plan: { ...first, services: { [web]: withoutArtifact } },
      }).pipe(Effect.provide(Cache.layer)),
    );

    const replanned = await plan();

    expect(replanned.services[web]?.artifact).toEqual({ kind: "ref", ref: "nginx:alpine" });
  } finally {
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("a scripts-only manifest edit replans but reuses the Node artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-node-pm-convergence-"));
  const cacheRoot = join(root, "cache");
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
  const name = "node-pm-convergence";
  const web = ServiceName.make("web");
  const document = literalTestLandofile(
    { name, runtime: 4, services: { [web]: { type: "node:22", primary: true, endpoints: [] } } },
    root,
  );
  const layer = Planner.layer.pipe(
    Layer.provide(Layer.mergeAll(Cache.layer, Registry.layer, FileSystem.layer)),
  );
  const plan = () =>
    Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) => planner.plan(document, TestRuntimeProvider.capabilities)).pipe(
        Effect.provide(layer),
      ),
    );
  const writeManifest = (value: Record<string, unknown>) =>
    writeFile(join(root, "package.json"), JSON.stringify(value));
  const key = async () => {
    const planned = await plan();
    const service = planned.services[web];
    if (service === undefined) throw new TypeError("Expected web service");
    return Effect.runPromise(buildKeyForService(TestRuntimeProvider, service));
  };
  try {
    const keys = spyOn(AppPlanCache, "deriveAppPlanCacheKey");
    try {
      await writeManifest({ name: "app", packageManager: "pnpm@9.15.0", scripts: { test: "bun test" } });
      const firstKey = await key();
      const firstInput = keys.mock.calls.at(-1)?.[0] as unknown;

      await writeManifest({ name: "renamed", packageManager: "pnpm@9.15.0", private: true });
      const secondKey = await key();
      const secondInput = keys.mock.calls.at(-1)?.[0] as unknown;

      expect(JSON.stringify(secondInput)).not.toBe(JSON.stringify(firstInput));
      expect(secondKey).toBe(firstKey);

      await writeManifest({ name: "renamed", packageManager: "pnpm@9.16.0" });
      expect(await key()).not.toBe(firstKey);
    } finally {
      keys.mockRestore();
    }
  } finally {
    if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    await rm(root, { recursive: true, force: true });
  }
});
