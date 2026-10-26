import { expect, test } from "bun:test";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeTestManagedFileStore } from "@lando/managed-file/testing";
import { makeLandoPaths } from "@lando/paths";
import { PluginLoadError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  GlobalConfig,
  PluginManifest,
  ProviderId,
} from "@lando/sdk/schema";
import {
  AppPlanSanitizer,
  ConfigService,
  ContainerHelperAssets,
  Downloader,
  ManagedFileService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { TeardownProvider } from "../../src/providers/app-placement.ts";
import { makeRuntimeProviderRegistry } from "../../src/providers/registry.ts";
import { makeTestDownloader } from "../../src/testing/downloader.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const root = AbsolutePath.make("/tmp/applied-state-registry/app");
const plan: AppPlan = {
  id: AppId.make("applied-owner"),
  name: "applied-owner",
  slug: "applied-owner",
  root,
  identity: { appRoot: root, ownerKey: "applied-owner-key" },
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00Z"), source: "test", runtime: 4 },
};
const unavailable = (providerId: string, operation: string) =>
  new ProviderUnavailableError({
    providerId,
    operation,
    message: `${providerId} ${operation} unavailable`,
    remediation: "Install or start the selected runtime provider, then re-run the failed command.",
  });

const moduleFor = (
  id: string,
  inventory: Effect.Effect<ReadonlyArray<AppPlan>, ProviderUnavailableError>,
  initialize: Effect.Effect<RuntimeProviderShape, ProviderUnavailableError>,
): LandoPluginModule => {
  const providerId = ProviderId.make(id);
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: `@example/${id}`,
    version: "1.0.0",
    api: 4,
    contributes: { providers: [id] },
  });
  const contribution = {
    id: providerId,
    appliedPlans: () => inventory,
    make: () =>
      initialize.pipe(
        Effect.map((provider) => ({ ...TestRuntimeProvider, ...provider, id, appliedPlans: inventory })),
      ),
  };
  return { name: manifest.name, manifest, runtimeProviders: new Map([[providerId, contribution]]) };
};

const run = (
  modules: ReadonlyArray<LandoPluginModule>,
  observe = false,
  exactRoot?: AbsolutePath,
  selected?: ProviderId,
) => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: "podman" });
  const unsupported = (name: string) =>
    Effect.fail(
      new PluginLoadError({
        message: "unused",
        pluginName: name,
        remediation: "Install or register the plugin, then retry.",
      }),
    );
  const httpClient = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))),
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      ConfigService,
      ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    ),
    Layer.succeed(
      PluginRegistry,
      PluginRegistry.of({
        list: Effect.succeed(modules.map((module) => module.manifest)),
        load: unsupported,
        loadServiceType: unsupported,
        loadServiceFeature: unsupported,
        loadAppFeature: unsupported,
      }),
    ),
    Layer.succeed(Downloader, Effect.runSync(makeTestDownloader()).service),
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.succeed(
      ContainerHelperAssets,
      ContainerHelperAssets.of({ resolve: () => Effect.die("unused helper") }),
    ),
    Layer.succeed(ManagedFileService, Effect.runSync(makeTestManagedFileStore()).service),
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: "/tmp/applied-state-registry" })),
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(AppPlanSanitizer, AppPlanSanitizer.of({ sanitizeForPersistence: (value) => value })),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      if (exactRoot !== undefined) {
        return yield* registry.appliedPlansFor(exactRoot);
      }
      if (observe) {
        if (registry.observeRuntime === undefined) return yield* Effect.die("missing observer");
        return yield* registry.observeRuntime;
      }
      const selected = yield* registry.resolveAppliedPlan(root);
      return selected === undefined
        ? undefined
        : {
            plan: selected,
            providerId: (yield* registry.select(selected)).id,
          };
    }).pipe(
      Effect.provide(
        makeRuntimeProviderRegistry(modules, {
          enforce: async () => undefined,
          verify: async () => undefined,
        }).pipe(Layer.provide(dependencies)),
      ),
      Effect.result,
      Effect.provideService(TeardownProvider, selected),
    ),
  );
};

test("provider-scoped resolution disambiguates two applied owners without reading the other provider", async () => {
  const dockerPlan = { ...plan, provider: ProviderId.make("docker") };
  const modules = [
    moduleFor(
      "lando",
      Effect.die("must not read excluded provider"),
      Effect.die("must not initialize excluded provider"),
    ),
    moduleFor("docker", Effect.succeed([dockerPlan]), Effect.succeed(TestRuntimeProvider)),
  ];
  const result = await run(modules, false, undefined, dockerPlan.provider);
  expect(result).toMatchObject({ _tag: "Success", success: { plan: dockerPlan, providerId: "docker" } });
});

test("recovers the persisted owner when an unrelated provider cannot initialize", async () => {
  // Given: the default is Podman, but Lando owns the saved app; Podman has no saved claim.
  let unrelatedInitializations = 0;
  const modules = [
    moduleFor("lando", Effect.succeed([plan]), Effect.succeed(TestRuntimeProvider)),
    moduleFor(
      "podman",
      Effect.succeed([]),
      Effect.suspend(() => {
        unrelatedInitializations += 1;
        return Effect.fail(unavailable("podman", "select"));
      }),
    ),
  ];
  // When
  const result = await run(modules);
  // Then
  expect(result).toMatchObject({ _tag: "Success", success: { plan, providerId: "lando" } });
  expect(unrelatedInitializations).toBe(0);
});

test("exact-root placement reads contribution plans without constructing any runtime", async () => {
  const modules = [
    moduleFor(
      "lando",
      Effect.succeed([
        plan,
        { ...plan, identity: { appRoot: AbsolutePath.make(`${root}/child`), ownerKey: "child" } },
      ]),
      Effect.die("must not construct managed runtime"),
    ),
    moduleFor("docker", Effect.succeed([]), Effect.die("must not introspect Docker capabilities")),
  ];
  const result = await run(modules, false, root);
  expect(result).toMatchObject({ _tag: "Success", success: [plan] });
});

test.each([false, true])(
  "host snapshots retain plans while gating runtime listing on running: %s",
  async (running) => {
    const inspected: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      isAvailable: Effect.succeed(true),
      getStatus: Effect.succeed({ running }),
      list: () =>
        Effect.sync(() => {
          inspected.push("services");
          return [];
        }),
      listVolumes: () =>
        Effect.sync(() => {
          inspected.push("volumes");
          return [];
        }),
    };
    const result = await run(
      [
        moduleFor("lando", Effect.succeed([plan]), Effect.succeed(provider)),
        moduleFor("podman", Effect.succeed([]), Effect.fail(unavailable("podman", "select"))),
      ],
      true,
    );
    expect(result).toMatchObject({
      _tag: "Success",
      success: [
        { providerId: "lando", appliedPlans: [plan], runtimeObserved: running, services: [], volumes: [] },
        { providerId: "podman", appliedPlans: [], runtimeObserved: false, services: [], volumes: [] },
      ],
    });
    expect(inspected).toEqual(running ? ["services", "volumes"] : []);
  },
);

test("propagates owner initialization failure after recovering its plan", async () => {
  // Given
  const failure = unavailable("lando", "select");
  // When
  const result = await run([moduleFor("lando", Effect.succeed([plan]), Effect.fail(failure))]);
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure });
});

test("propagates another provider's persisted inventory failure even with a matching owner", async () => {
  // Given
  const failure = unavailable("podman", "applied-state.list");
  // When
  const result = await run([
    moduleFor("lando", Effect.succeed([plan]), Effect.succeed(TestRuntimeProvider)),
    moduleFor("podman", Effect.fail(failure), Effect.fail(unavailable("podman", "select"))),
  ]);
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure });
});

test("rejects a mismatched supplier without initializing its runtime", async () => {
  // Given / When
  const result = await run([
    moduleFor("podman", Effect.succeed([plan]), Effect.fail(unavailable("podman", "select"))),
  ]);
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "AppResolveError", detail: "applied-state-provider" },
  });
});

test("rejects conflicting persisted root claims even when one runtime is unavailable", async () => {
  // Given / When
  const result = await run([
    moduleFor("lando", Effect.succeed([plan]), Effect.succeed(TestRuntimeProvider)),
    moduleFor(
      "podman",
      Effect.succeed([{ ...plan, provider: ProviderId.make("podman") }]),
      Effect.fail(unavailable("podman", "select")),
    ),
  ]);
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "AppResolveError", reason: "ambiguous" },
  });
});

test("skips unavailable unused providers when no persisted owner exists", async () => {
  // Given: never-started teardown must not require every bundled runtime daemon.
  const failure = unavailable("podman", "select");
  // When
  const result = await run([
    moduleFor("lando", Effect.succeed([]), Effect.succeed(TestRuntimeProvider)),
    moduleFor("podman", Effect.succeed([]), Effect.fail(failure)),
  ]);
  // Then
  expect(result).toMatchObject({ _tag: "Success", success: undefined });
});

test.each([false, true])(
  "inspects runtime resources only when the daemon is running: %s",
  async (running) => {
    // Given: availability means supported, not that the managed daemon is running.
    const inspected: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      isAvailable: Effect.succeed(true),
      getStatus: Effect.succeed({ running }),
      list: () =>
        Effect.sync(() => {
          inspected.push("services");
          return [];
        }),
      listVolumes: () =>
        Effect.sync(() => {
          inspected.push("volumes");
          return [];
        }),
    };
    // When
    const result = await run([moduleFor("lando", Effect.succeed([]), Effect.succeed(provider))]);
    // Then
    expect(result).toMatchObject({ _tag: "Success", success: undefined });
    expect(inspected).toEqual(running ? ["services", "volumes"] : []);
  },
);
