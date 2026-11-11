import { expect, test } from "bun:test";
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
  appIdentityKey,
} from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
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
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

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

test("idle installed providers retain ownership evidence without listing resources", async () => {
  const provider = {
    ...TestRuntimeProvider,
    cleanupOwnedResources: () => Effect.die("observation must not clean up"),
    getStatus: Effect.succeed({ state: "idle" as const }),
    list: () => Effect.die("idle inventory must not be listed"),
    listVolumes: () => Effect.die("idle volumes must not be listed"),
  };
  const module = moduleFor("lando", Effect.succeed([]), Effect.succeed(provider));
  const contribution = module.runtimeProviders?.get(ProviderId.make("lando"));
  if (contribution === undefined) throw new Error("missing provider contribution");
  const ownership = {
    appRoot: root,
    ownerKey: appIdentityKey("owner", root),
    providerId: ProviderId.make("lando"),
    appIds: [plan.id],
  };
  const result = await run(
    [
      {
        ...module,
        runtimeProviders: new Map([
          [ProviderId.make("lando"), { ...contribution, resourceOwnership: () => Effect.succeed(ownership) }],
        ]),
      },
    ],
    "teardown",
    root,
  );
  expect(result).toMatchObject({ _tag: "Success", success: { kind: "owned", ownership: [ownership] } });
});

test.each([false, true])(
  "teardown fails with the status remediation only for a provider that recorded state for the root (recorded: %s)",
  async (withOwnership) => {
    const failure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "getStatus",
      message: "Managed runtime storage is unreadable.",
      remediation: "Restore access to the managed runtime storage directory, then retry.",
    });
    const provider = {
      ...TestRuntimeProvider,
      getStatus: Effect.fail(failure),
      cleanupOwnedResources: () => Effect.die("must not clean up after a failed observation"),
      list: () => Effect.die("failed status must not list containers"),
      listVolumes: () => Effect.die("failed status must not list volumes"),
    };
    const module = moduleFor("lando", Effect.succeed([]), Effect.succeed(provider));
    const contribution = module.runtimeProviders?.get(ProviderId.make("lando"));
    if (contribution === undefined) throw new Error("missing provider contribution");
    const modules = [
      {
        ...module,
        runtimeProviders: new Map([
          [
            ProviderId.make("lando"),
            {
              ...contribution,
              resourceOwnership: () =>
                Effect.succeed(
                  withOwnership
                    ? {
                        appRoot: root,
                        ownerKey: appIdentityKey("owner", root),
                        providerId: ProviderId.make("lando"),
                        appIds: [plan.id],
                      }
                    : undefined,
                ),
            },
          ],
        ]),
      },
    ];
    // A provider with no record for this root cannot hold its resources, so its outage must not block teardown.
    expect(await run(modules, "teardown", root)).toMatchObject(
      withOwnership ? { _tag: "Failure", failure } : { _tag: "Success", success: { kind: "absent" } },
    );
    expect(await run(modules, true)).toMatchObject({
      _tag: "Success",
      success: [
        {
          providerId: "lando",
          appliedPlans: [],
          runtimeObserved: false,
          services: [],
          volumes: [],
        },
      ],
    });
  },
);

const run = (
  modules: ReadonlyArray<LandoPluginModule>,
  observe: boolean | "teardown" = false,
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
      if (observe === "teardown") return yield* registry.resolveTeardownEvidence(exactRoot ?? root);
      if (exactRoot !== undefined) {
        return yield* registry.appliedPlansFor(exactRoot, selected);
      }
      if (observe) {
        if (registry.observeRuntime === undefined) return yield* Effect.die("missing observer");
        return yield* registry.observeRuntime;
      }
      const resolved = yield* registry.resolveAppliedPlan(root);
      return resolved === undefined
        ? undefined
        : {
            plan: resolved,
            providerId: (yield* registry.select(resolved)).id,
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

test("provider-scoped applied plans never read another provider's state", async () => {
  const dockerPlan = { ...plan, provider: ProviderId.make("docker") };
  const modules = [
    moduleFor(
      "lando",
      Effect.die("must not read excluded provider"),
      Effect.die("must not initialize excluded provider"),
    ),
    moduleFor("docker", Effect.succeed([dockerPlan]), Effect.succeed(TestRuntimeProvider)),
  ];
  expect(await run(modules, false, root, dockerPlan.provider)).toMatchObject({
    _tag: "Success",
    success: [{ id: dockerPlan.id, provider: "docker" }],
  });
});

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
      getStatus: Effect.succeed({ state: running ? ("running" as const) : ("idle" as const) }),
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
      getStatus: Effect.succeed({ state: running ? ("running" as const) : ("idle" as const) }),
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
