import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openLandoRuntime } from "@lando/core";
import { AbsolutePath, type AppPlan, ProviderId } from "@lando/core/schema";
import {
  PrivilegeService,
  RouterService,
  RuntimeProvider,
  RuntimeProviderRegistry,
  ScratchAppService,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { makeLandoPaths } from "@lando/paths";
import type { LandoRuntime } from "@lando/sdk/app";
import { TestRouterService } from "@lando/sdk/test";
import { Effect, Layer, Option, Schema } from "effect";
import { withCwd } from "../_support/temp-cwd.ts";

const Registry = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const providerLayers = () => {
  const plans = new Map<AbsolutePath, AppPlan>();
  const provider = RuntimeProvider.of({
    ...TestRuntimeProvider,
    appliedPlans: Effect.sync(() => [...plans.values()]),
    apply: (plan, options) =>
      TestRuntimeProvider.apply(plan, options).pipe(
        Effect.tap(() => Effect.sync(() => void plans.set(plan.root, options?.recordedPlan ?? plan))),
      ),
    destroy: (target, options) =>
      TestRuntimeProvider.destroy(target, options).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (options.removeState !== false && target.plan !== undefined) plans.delete(target.plan.root);
          }),
        ),
      ),
    inspect: (target) =>
      TestRuntimeProvider.inspect(target).pipe(
        Effect.map((observed) => {
          const plan = [...plans.values()].find((plan) => plan.id === target.app);
          return {
            ...observed,
            providerId: ProviderId.make(TestRuntimeProvider.id),
            ...(plan === undefined ? {} : { appRoot: plan.root }),
            containerId: `${target.app}-${target.service}`,
            health: "healthy" as const,
          };
        }),
      ),
    list: () =>
      Effect.sync(() =>
        [...plans.values()].flatMap((plan) =>
          Object.values(plan.services).map((service) => ({
            app: plan.id,
            appRoot: plan.root,
            providerId: plan.provider,
            service: service.name,
            containerId: `${plan.id}-${service.name}`,
            status: "running" as const,
            health: "healthy" as const,
            publications: { status: "unknown" as const },
          })),
        ),
      ),
  });
  return [
    Layer.succeed(RuntimeProvider, provider),
    Layer.succeed(
      PrivilegeService,
      PrivilegeService.of({
        elevate: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ),
    Layer.succeed(RouterService, RouterService.of({ ...TestRouterService, id: "traefik" })),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        resolveAppliedPlan: (root) => Effect.sync(() => plans.get(root)),
        resolveTeardownEvidence: (root) =>
          Effect.sync(() => {
            const plan = plans.get(root);
            return plan === undefined ? { kind: "absent" as const } : { kind: "applied" as const, plan };
          }),
        appliedPlansFor: (root) =>
          Effect.sync(() => {
            const plan = plans.get(root);
            return plan === undefined ? [] : [plan];
          }),
        list: Effect.succeed([ProviderId.make(provider.id)]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
  ];
};

const fixture = async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "lando-cache-wipe-")));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const appRoot = AbsolutePath.make(join(base, "app"));
  const config = {
    userDataRoot: AbsolutePath.make(join(base, "data")),
    userCacheRoot: AbsolutePath.make(join(base, "cache")),
    userConfRoot: AbsolutePath.make(join(base, "conf")),
    defaultProviderId: TestRuntimeProvider.id,
  };
  await Promise.all(
    [appRoot, config.userDataRoot, config.userCacheRoot, config.userConfRoot].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const name = basename(base).toLowerCase();
  await Bun.write(
    join(appRoot, ".lando.yml"),
    `name: ${name}\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nrouter:\n  enabled: false\nservices:\n  cache:\n    type: redis\n    primary: true\n    home: false\n`,
  );
  const ambient = makeLandoPaths();
  const paths = makeLandoPaths(config);
  cleanups.push(() => rm(ambient.appPlanCacheFile(name, appRoot), { force: true }));
  expect(paths.roots.userDataRoot).not.toBe(ambient.roots.userDataRoot);
  expect(paths.roots.userCacheRoot).not.toBe(ambient.roots.userCacheRoot);
  expect(paths.roots.userConfRoot).not.toBe(ambient.roots.userConfRoot);
  const layers = providerLayers();
  const run = <A, E>(use: (runtime: LandoRuntime) => Effect.Effect<A, E>) =>
    withCwd(
      appRoot,
      () =>
        Effect.runPromise(
          Effect.scoped(
            openLandoRuntime({
              cwd: appRoot,
              config,
              plugins: { policy: "bundled-only", layers },
            }).pipe(Effect.flatMap(use)),
          ),
        ),
      [base],
    );
  return {
    appRoot,
    name,
    paths,
    ambient,
    run,
    wipe: () => rm(config.userCacheRoot, { recursive: true, force: true }),
  };
};

describe("cache wipe library contract", () => {
  test("user lifecycle survives cache deletion and runtime reopen with configured roots", async () => {
    const f = await fixture();
    const started = await f.run((runtime) => runtime.app().pipe(Effect.flatMap((app) => app.start())));
    expect(started.servicesStarted.map((service) => service.name)).toEqual(["cache"]);
    expect(await Bun.file(f.paths.appPlanCacheFile(f.name, f.appRoot)).exists()).toBe(true);
    expect(await Bun.file(f.ambient.appPlanCacheFile(f.name, f.appRoot)).exists()).toBe(false);
    await f.wipe();
    const observed = await f.run((runtime) =>
      Effect.gen(function* () {
        const app = yield* runtime.app();
        const info = yield* app.info();
        const stopped = yield* app.stop();
        return { info, stopped };
      }),
    );
    expect(observed.info.app).toBe(f.name);
    expect(observed.info.services.map((service) => service.service)).toEqual(["cache"]);
    expect(observed.stopped.servicesStopped).toEqual(["cache"]);
    await f.wipe();
    const restarted = await f.run((runtime) =>
      Effect.gen(function* () {
        const app = yield* runtime.app();
        const started = yield* app.start();
        const destroyed = yield* app.destroy();
        return { started, destroyed };
      }),
    );
    expect(restarted.started.servicesStarted.map((service) => service.name)).toEqual(["cache"]);
    expect(restarted.destroyed.app).toBe(f.name);
    expect(await Bun.file(f.ambient.appPlanCacheFile(f.name, f.appRoot)).exists()).toBe(false);
  }, 60_000);

  test("detached scratch stays discoverable and destroyable after cache deletion and runtime reopen", async () => {
    const f = await fixture();
    const handle = await f.run((runtime) =>
      Effect.scoped(runtime.scratch({ source: { kind: "fork" }, detached: true, isolate: "none" })),
    );
    const instanceRoot = join(f.paths.scratchDir, handle.id);
    cleanups.push(() => rm(join(f.ambient.scratchDir, handle.id), { recursive: true, force: true }));
    expect(await Bun.file(join(f.paths.roots.userDataRoot, "scratch", "registry.bin")).exists()).toBe(true);
    expect(await Bun.file(join(instanceRoot, "plan.bin")).exists()).toBe(true);
    expect(existsSync(instanceRoot)).toBe(true);
    const registry = Schema.decodeUnknownSync(Registry)(
      await Bun.file(join(f.paths.scratchDir, "registry.bin")).json(),
    );
    expect(registry.data.map((entry) => entry.id)).toEqual([handle.id]);
    expect(await Bun.file(join(f.ambient.scratchDir, handle.id, "plan.bin")).exists()).toBe(false);
    const ambientRegistryFile = Bun.file(join(f.ambient.scratchDir, "registry.bin"));
    if (await ambientRegistryFile.exists()) {
      const ambientRegistry = Schema.decodeUnknownSync(Registry)(await ambientRegistryFile.json());
      expect(ambientRegistry.data.map((entry) => entry.id)).not.toContain(handle.id);
    }
    await f.wipe();
    const result = await f.run((runtime) =>
      Effect.gen(function* () {
        const scratch = Option.getOrThrow(yield* runtime.run(Effect.serviceOption(ScratchAppService)));
        const listed = yield* scratch.list();
        const info = yield* scratch.info(handle.id);
        const paths = yield* scratch.paths(handle.id);
        yield* scratch.destroy(handle.id);
        return { listed, info, paths };
      }),
    );
    expect(result.listed.map((entry) => entry.id)).toEqual([handle.id]);
    expect(result.info.id).toBe(handle.id);
    expect(result.info.status).toBe("detached");
    expect(result.info.endpoints.map((entry) => entry.service)).toEqual(["cache"]);
    expect(result.paths.instanceRoot).toBe(AbsolutePath.make(instanceRoot));
    expect(existsSync(instanceRoot)).toBe(false);
    expect(await Bun.file(f.ambient.appPlanCacheFile(handle.id, result.paths.root)).exists()).toBe(false);
  }, 60_000);
});
