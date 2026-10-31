import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer, Queue, Schema, Stream } from "effect";

import { makeLandoPaths } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  AppPlan as AppPlanSchema,
  GlobalConfig,
  type PluginManifest,
  ProviderId,
  ServiceName,
  ServicePlan,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  ConfigService,
  EnvironmentValueResolver,
  EventService,
  GlobalAppService,
  type LandoEvent,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { bundledPluginModules } from "../../src/composition.ts";
import { globalPolicyBucket } from "../../src/global-app/enablement.ts";
import {
  forgetGlobalEnsure,
  globalEnsureRecord,
  rememberGlobalEnsure,
} from "../../src/global-app/ensure-cache.ts";
import { renderGlobalDist } from "../../src/global-app/service.ts";
import { ensureGlobalServicesRunning } from "../../src/operations/ensure-global-services.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const metadata = { runtime: 4 as const, resolvedAt: DateTime.makeUnsafe(0), source: "warm-test" };

const withFixture = async (use: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-global-warm-"));
  try {
    await use(await makeFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const makeFixture = async (directory: string) => {
  const root = AbsolutePath.make(join(directory, "global"));
  await mkdir(root);
  const paths = {
    root,
    distLandofile: AbsolutePath.make(join(root, ".lando.dist.yml")),
    userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
  };
  await writeFile(
    paths.userLandofile,
    "services:\n  app:\n    type: compose\n    image: app:v1\n    dependsOn: [dependency]\n  dependency:\n    type: compose\n    image: dep:v1\n",
  );
  const calls = { generation: 0, planning: 0, build: 0, apply: 0, list: 0, inspect: 0 };
  const config = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: "lando", proxy: {} });
  const events: LandoEvent[] = [];
  const runtimes = new Map<string, ServiceRuntimeInfo>();
  let onEvent: ((event: LandoEvent) => Effect.Effect<void>) | undefined;
  let applied: AppPlan | undefined;
  let capabilities = TestRuntimeProvider.capabilities;
  let catalog: ReadonlyArray<PluginManifest> = [];
  let omitOwnership = false;
  const providerId = ProviderId.make("lando");
  const provider = {
    ...TestRuntimeProvider,
    get capabilities() {
      return capabilities;
    },
    list: () =>
      Effect.sync(() => {
        calls.list++;
        // Provider inventories need not expose start times; inspect verifies those.
        return [...runtimes.values()].map(({ lastStartedAt: _, appRoot, ...runtime }) => ({
          ...runtime,
          // Some inventories expose a human-duration-derived invalid date.
          lastStartedAt: new Date(Number.NaN),
          ...(omitOwnership || appRoot === undefined ? {} : { appRoot }),
        }));
      }),
    inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
      Effect.sync(() => {
        calls.inspect++;
        const runtime = runtimes.get(target.service);
        if (runtime === undefined) throw new Error(`Missing test runtime ${target.service}`);
        return runtime;
      }),
    apply: (plan: AppPlan, options: Parameters<typeof TestRuntimeProvider.apply>[1]) =>
      Effect.sync(() => {
        calls.apply++;
        applied = options.recordedPlan ?? plan;
        for (const service of Object.values(plan.services))
          runtimes.set(service.name, {
            app: plan.id,
            appRoot: plan.root,
            providerId,
            service: service.name,
            containerId: `container-${service.name}`,
            lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(-10_000)),
            status: "running",
            state: "running",
            publications: { status: "present", bindings: [] },
          });
        return { changed: true };
      }),
  };
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed(applied === undefined ? [] : [applied]),
    resolveAppliedPlan: () => Effect.succeed(applied),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    list: Effect.succeed([providerId]),
    capabilities: Effect.sync(() => capabilities),
    select: () => Effect.succeed(provider),
  });
  const state = makeTestStateStore();
  const layer = Layer.mergeAll(
    state.layer,
    BunFileSystem.layer,
    PrivateFileAccessService.layer,
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        userDataRoot: directory,
        userConfRoot: join(directory, "conf"),
        userCacheRoot: join(directory, "cache"),
        systemPluginRoot: join(directory, "plugins"),
        env: {},
        platform: "linux",
      }),
    ),
    Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: (key) => Effect.succeed(config[key]),
      }),
    ),
    Layer.succeed(
      GlobalAppService,
      GlobalAppService.of({
        id: "global",
        root: Effect.succeed(root),
        paths: Effect.succeed(paths),
        providerId: Effect.succeed(providerId),
        ensureRoot: Effect.void,
        ensureUserLandofile: Effect.succeed({ path: paths.userLandofile, created: false }),
        ensureRunning: () => Effect.succeed([]),
        regenerateDist: (options) =>
          Effect.promise(async () => {
            calls.generation++;
            await writeFile(paths.distLandofile, renderGlobalDist(options?.services ?? {}));
            return { path: paths.distLandofile, status: "unchanged" as const, serviceIds: [] };
          }),
      }),
    ),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.sync(() => catalog),
        load: () => Effect.die("unused"),
        loadServiceType: () => Effect.die("unused"),
        loadServiceFeature: () => Effect.die("unused"),
        loadAppFeature: () => Effect.die("unused"),
        declaredProviderCapabilities: () => capabilities,
      }),
    ),
    Layer.succeed(RuntimeProviderRegistry, registry),
    Layer.succeed(
      AppPlanner,
      AppPlanner.of({
        plan: (landofile) =>
          Effect.sync(() => {
            calls.planning++;
            const planned: AppPlan = {
              valueModel: 1 as const,
              id: AppId.make("global"),
              name: "global",
              slug: "global",
              root,
              provider: providerId,
              routes: [],
              stores: [],
              fileSync: [],
              extensions: {},
              metadata,
              services: Object.fromEntries(
                Object.entries(landofile.document.services ?? {}).map(([name, service]) => [
                  name,
                  Schema.decodeUnknownSync(ServicePlan)({
                    name: ServiceName.make(name),
                    type: "compose",
                    provider: providerId,
                    primary: false,
                    artifact: { kind: "ref" as const, ref: service.image ?? "test:latest" },
                    environment: {},
                    mounts: [],
                    endpoints: [],
                    routes: [],
                    hostAliases: [],
                    dependsOn: (service.dependsOn ?? []).map((dependency) =>
                      typeof dependency === "string"
                        ? {
                            service: ServiceName.make(dependency),
                            condition: "service_started" as const,
                            required: true,
                          }
                        : {
                            ...dependency,
                            condition: dependency.condition ?? "service_started",
                            required: dependency.required ?? true,
                          },
                    ),
                    metadata: { ...metadata, resolvedAt: DateTime.formatIso(metadata.resolvedAt) },
                    extensions: {},
                  }),
                ]),
              ),
            };
            return { ...AppPlanSchema.make(planned), valueModel: 1 as const };
          }),
      }),
    ),
    Layer.succeed(
      BuildOrchestrator,
      BuildOrchestrator.of({
        build: (plan) =>
          Effect.sync(() => {
            calls.build++;
            return plan;
          }),
        buildApp: () => Effect.void,
      }),
    ),
    Layer.succeed(
      EnvironmentValueResolver,
      EnvironmentValueResolver.of({
        openSession: () => Effect.succeed({ resolveEnvironment: () => Effect.succeed({}) }),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.gen(function* () {
            events.push(event);
            if (onEvent !== undefined) yield* onEvent(event);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<LandoEvent>(),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
  );
  const ensure = (services = ["app"], signal?: AbortSignal) =>
    Effect.runPromise(
      ensureGlobalServicesRunning({ services, ...(signal === undefined ? {} : { signal }) }).pipe(
        Effect.provide(layer),
      ),
    );
  return {
    root,
    paths,
    calls,
    events,
    runtimes,
    ensure,
    registry,
    layer,
    setCatalog: (next: ReadonlyArray<PluginManifest>) => {
      catalog = next;
    },
    setCapabilities: (next: typeof capabilities) => {
      capabilities = next;
    },
    setOmitOwnership: (next: boolean) => {
      omitOwnership = next;
    },
    onEvent: (hook: typeof onEvent) => {
      onEvent = hook;
    },
    changePolicy: () =>
      Effect.runPromise(
        globalPolicyBucket().pipe(
          Effect.flatMap((bucket) => bucket.set({ revision: 1, plugins: {} })),
          Effect.provide(layer),
        ),
      ),
  };
};

test("repeated ensure verifies owned running dependencies and skips generation, planning, build and apply", async () => {
  await withFixture(async (f) => {
    await f.ensure();
    expect(globalEnsureRecord(f.registry, f.root)).toBeDefined();
    expect(f.calls).toMatchObject({ generation: 1, planning: 1, build: 1, apply: 1 });
    const firstInspects = f.calls.inspect;
    const firstLists = f.calls.list;
    const result = await f.ensure();
    expect(result.servicesStarted.map((service) => service.name).sort()).toEqual(["app", "dependency"]);
    expect(f.calls).toMatchObject({ generation: 1, planning: 1, build: 1, apply: 1 });
    expect(f.calls.list).toBeGreaterThan(firstLists);
    expect(f.calls.inspect).toBeGreaterThan(firstInspects);
    expect(f.events.filter((event) => "cached" in event).map((event) => event.cached)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

for (const change of [
  "same-size-source",
  "new-layer",
  "policy",
  "capabilities",
  "identity",
  "ownership",
  "stopped",
] as const) {
  test(`${change} invalidates a warm record`, async () => {
    await withFixture(async (f) => {
      await f.ensure();
      if (change === "same-size-source")
        await writeFile(
          f.paths.userLandofile,
          "services:\n  app:\n    type: compose\n    image: app:v2\n    dependsOn: [dependency]\n  dependency:\n    type: compose\n    image: dep:v1\n",
        );
      if (change === "new-layer")
        await writeFile(join(f.root, ".lando.local.yml"), "services:\n  app:\n    image: app:v2\n");
      if (change === "policy") await f.changePolicy();
      if (change === "capabilities")
        f.setCapabilities({ ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: false });
      if (change === "ownership") f.setOmitOwnership(true);
      if (change === "identity" || change === "stopped") {
        const runtime = f.runtimes.get("dependency");
        if (runtime === undefined) throw new Error("expected dependency");
        f.runtimes.set("dependency", {
          ...runtime,
          ...(change === "identity" ? { containerId: "replacement" } : { status: "stopped" as const }),
        });
      }
      await f.ensure();
      expect(f.calls).toMatchObject({ generation: 2, planning: 2, build: 2, apply: 2 });
    });
  });
}

test("a pre-start hook source mutation rejects warm reuse without applying or publishing success", async () => {
  await withFixture(async (f) => {
    await f.ensure();
    f.onEvent((event) =>
      event._tag === "pre-global-start" && event.cached === true
        ? Effect.promise(() =>
            writeFile(join(f.root, ".lando.local.yml"), "services:\n  app:\n    image: app:v2\n"),
          )
        : Effect.void,
    );
    await expect(f.ensure()).rejects.toMatchObject({ _tag: "GlobalAppError", operation: "ensureRunning" });
    expect(f.calls.apply).toBe(1);
    expect(f.events.filter((event) => event._tag === "post-global-start")).toHaveLength(1);
    f.onEvent(undefined);
    await f.ensure();
    expect(f.calls.apply).toBe(2);
  });
});

test("TypeScript layers conservatively retain the normal startup path", async () => {
  await withFixture(async (f) => {
    await writeFile(
      join(f.root, ".lando.local.ts"),
      "export default { services: { app: { image: 'app:v2' } } };\n",
    );
    await f.ensure();
    await f.ensure();
    expect(f.calls.apply).toBe(2);
    expect(globalEnsureRecord(f.registry, f.root)).toBeUndefined();
  });
});

test("local include contents and ambient environment invalidate reuse", async () => {
  await withFixture(async (f) => {
    const include = join(f.root, "included.yml");
    await writeFile(include, "services:\n  app:\n    image: app:v1\n");
    await writeFile(join(f.root, ".lando.local.yml"), "includes: [included.yml]\n");
    await f.ensure();
    expect(globalEnsureRecord(f.registry, f.root)).toBeDefined();
    await f.ensure();
    expect(f.calls.apply).toBe(1);
    await writeFile(include, "services:\n  app:\n    image: app:v2\n");
    await f.ensure();
    expect(f.calls.apply).toBe(2);
    const name = "LANDO_WARM_TEST_CHANGE";
    const previous = process.env[name];
    try {
      process.env[name] = "changed";
      await f.ensure();
      expect(f.calls.apply).toBe(3);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = previous;
    }
  });
});

test("aborting a warm hook joins its finalizer before releasing the mutation guard", async () => {
  await withFixture(async (f) => {
    await f.ensure();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finalized = false;
    f.onEvent((event) =>
      event._tag === "pre-global-start" && event.cached === true
        ? Effect.sync(entered).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true;
              }),
            ),
          )
        : Effect.void,
    );
    const controller = new AbortController();
    const pending = f.ensure(["app"], controller.signal).then(
      () => "success",
      () => "interrupted",
    );
    await started;
    controller.abort();
    expect(await pending).toBe("interrupted");
    expect(finalized).toBe(true);
    expect(f.calls.apply).toBe(1);
    f.onEvent(undefined);
    await f.ensure();
    expect(f.calls.apply).toBe(2);
  });
});

test("bundled Mailpit and Traefik sources can take the verified warm path", async () => {
  await withFixture(async (f) => {
    const modules = bundledPluginModules().filter((plugin) =>
      ["@lando/service-lando", "@lando/proxy-traefik"].includes(plugin.name),
    );
    expect(modules).toHaveLength(2);
    f.setCatalog(modules.map((plugin) => plugin.manifest));
    await writeFile(f.paths.userLandofile, "# User overrides for the global Lando app.\n");
    f.setCapabilities({ ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: true });
    await f.ensure(["mailpit", "traefik"]);
    expect(globalEnsureRecord(f.registry, f.root)).toBeDefined();
    const firstLists = f.calls.list;
    await f.ensure(["mailpit", "traefik"]);
    expect(f.calls).toMatchObject({ generation: 1, planning: 1, build: 1, apply: 1 });
    expect(f.calls.list).toBeGreaterThan(firstLists);
  });
});

test("an invalid inspect timestamp cannot defect while remembering successful startup", async () => {
  await withFixture(async (f) => {
    await f.ensure();
    const record = globalEnsureRecord(f.registry, f.root);
    const runtime = f.runtimes.get("app");
    if (record === undefined || runtime === undefined) throw new Error("expected verified startup");
    forgetGlobalEnsure(f.registry, f.root);
    expect(() =>
      rememberGlobalEnsure(f.registry, record.plan, record.landofile, record.inputs, [
        {
          name: "app",
          state: "ready",
          runtime: { ...runtime, lastStartedAt: new Date(Number.NaN) },
        },
      ]),
    ).not.toThrow();
    expect(globalEnsureRecord(f.registry, f.root)).toBeUndefined();
  });
});

test("retargeting a local include symlink invalidates its canonical source provenance", async () => {
  await withFixture(async (f) => {
    const first = join(f.root, "first.yml");
    const second = join(f.root, "second.yml");
    const alias = join(f.root, "included.yml");
    await writeFile(first, "services:\n  app:\n    image: app:v1\n");
    await writeFile(second, "services:\n  app:\n    image: app:v2\n");
    await symlink(first, alias);
    await writeFile(join(f.root, ".lando.local.yml"), "includes: [included.yml]\n");
    await f.ensure();
    expect(globalEnsureRecord(f.registry, f.root)).toBeDefined();
    await f.ensure();
    expect(f.calls.apply).toBe(1);
    await rm(alias);
    await symlink(second, alias);
    await f.ensure();
    expect(f.calls.apply).toBe(2);
  });
});

test("historical sibling retention never admits that sibling through the warm desired graph", async () => {
  await withFixture(async (f) => {
    const desired = await readFile(f.paths.userLandofile, "utf8");
    await writeFile(
      f.paths.userLandofile,
      `${desired}  historical:\n    type: compose\n    image: historical:v1\n`,
    );
    await f.ensure(["app", "historical"]);
    // The old container remains real ownership evidence while its authored declaration disappears.
    await writeFile(f.paths.userLandofile, desired);
    await f.ensure();
    expect(f.runtimes.has("historical")).toBe(true);
    const record = globalEnsureRecord(f.registry, f.root);
    expect(record).toBeDefined();
    expect(record?.plan.services).not.toHaveProperty("historical");
    await f.ensure();
    expect(f.calls.apply).toBe(2);
    await expect(f.ensure(["historical"])).rejects.toMatchObject({ _tag: "GlobalServiceMissingError" });
    expect(f.calls.apply).toBe(2);
  });
});
