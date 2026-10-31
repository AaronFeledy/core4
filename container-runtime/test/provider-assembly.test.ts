import { describe, expect, test } from "bun:test";
import { AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { AppPlanSanitizer, ContainerHelperAssets, EventService, PathsService } from "@lando/sdk/services";
import { Effect, Layer, Schema, Stream } from "effect";
import { dataHelperImage } from "../src/data-plane.ts";
import {
  bindResolvedProviderOps,
  forgetAppliedPlanUnlessKept,
  makeProviderPlanState,
  noPlanErrorFactory,
  notImplementedError,
  providerHostInputs,
  rememberAppliedPlan,
} from "../src/provider-assembly.ts";

const passthroughRedactor = {
  redactString: (value: string) => value,
  redactValue: (value: unknown) => value,
} satisfies Redactor;

const plan = Schema.decodeSync(AppPlan)({
  id: "app",
  name: "app",
  slug: "app",
  root: "/app",
  provider: "lando",
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
});
const ctx = { providerId: "lando", remediation: "Retry.", env: {} };
const stateOptions = {
  ctx,
  providerId: ProviderId.make("lando"),
  providerName: "provider-lando",
  capabilities: { volumeSnapshot: "native" as const },
  redactor: passthroughRedactor,
  load: () => Effect.succeed(undefined),
  persist: () => Effect.void,
  remove: () => Effect.void,
};
const paths = PathsService.of({
  platform: "wsl",
  roots: {
    userConfRoot: "/conf",
    userCacheRoot: "/cache",
    userDataRoot: "/data",
    systemPluginRoot: "/system",
  },
  pluginsDir: "",
  systemPluginsDir: "",
  pluginStateDir: () => "",
  appPluginsDir: () => "",
  pluginAuthFile: "",
  binDir: "",
  installRecordFile: "",
  keysDir: "",
  certsDir: "",
  runtimeDir: "",
  runtimeBinDir: "",
  runtimeRunDir: "",
  runtimeStorageDir: "",
  runtimeConfigDir: "",
  hostProxyRunRoot: "",
  hostProxyRunDir: () => "",
  agentRelayRunDir: () => "",
  providerSocketPath: "",
  providerPidPath: "",
  globalAppRoot: "",
  snapshotsDir: "",
  ownerSnapshotsDir: () => "",
  managedFileLedger: () => "",
  toolDownloadsDir: () => "",
  logsDir: "",
  scratchDir: "",
  scratchRegistryFile: "",
  scratchRegistryLockFile: "",
  tunnelRegistryFile: "",
  tunnelRunDir: "",
  appCacheDir: () => "",
  appPlanCacheFile: () => "",
  shellHistoryFile: () => "",
  fileSyncSessionsDir: "",
  configFile: "",
  configDir: "",
  userIncludesDir: "",
  globalConfigFile: "",
  pluginTrustFile: "",
});
const resolveContainerHelper: typeof ContainerHelperAssets.Service.resolve = () =>
  Effect.die("helper resolution must stay lazy");
const sanitizeForPersistence = (value: AppPlan) => ({ ...value, name: "sanitized" });
const hostLayer = Layer.mergeAll(
  Layer.succeed(PathsService, paths),
  Layer.succeed(ContainerHelperAssets, { resolve: resolveContainerHelper }),
  Layer.succeed(AppPlanSanitizer, { sanitizeForPersistence }),
);

describe("provider assembly", () => {
  for (const recordedPlan of [undefined, { ...plan, name: "recorded" }]) {
    for (const reconcile of [false, true]) {
      test(`remembers selected plan with reconcile=${reconcile} when recorded=${recordedPlan !== undefined}`, async () => {
        const calls: unknown[] = [];
        const cache = {
          rememberPlan: (value: AppPlan, mode: boolean) =>
            Effect.sync(() => {
              calls.push([value, mode]);
            }),
        };
        await Effect.runPromise(
          rememberAppliedPlan(cache, plan, {
            reconcile,
            ...(recordedPlan === undefined ? {} : { recordedPlan }),
          }),
        );
        expect(calls).toEqual([[recordedPlan ?? plan, reconcile]]);
      });
    }
  }
  for (const removeState of [undefined, false, true]) {
    test(`forgets state only when removeState is not false (${removeState})`, async () => {
      const calls: string[] = [];
      const cache = {
        forgetPlan: (app: string) =>
          Effect.sync(() => {
            calls.push(app);
          }),
      };
      await Effect.runPromise(
        forgetAppliedPlanUnlessKept(cache, plan.id, removeState === undefined ? {} : { removeState }),
      );
      expect(calls).toEqual(removeState === false ? [] : [plan.id]);
    });
  }
  test("preserves Podman no-plan fields", () => {
    const factory = noPlanErrorFactory({
      providerId: "podman",
      implementer: "provider-podman",
      remediation: "Run `lando start` (or `lando app:start`) to start the app, then retry.",
    });
    const error = factory(plan.id, "exec");
    expect(error).toMatchObject({
      _tag: "ProviderUnavailableError",
      providerId: "podman",
      operation: "exec",
      message:
        'No applied plan found for app "app". provider-podman does implement exec, but the app must be started first.',
      remediation: "Run `lando start` (or `lando app:start`) to start the app, then retry.",
    });
  });
  test("preserves Lando no-plan fields", () => {
    const factory = noPlanErrorFactory({
      providerId: "lando",
      implementer: "The provider",
      remediation:
        "Run `lando start` (or `lando app:start`) to start the app, then retry. Alternatively, pass an AppPlan directly via `target.plan`.",
    });
    const error = factory(plan.id, "logs");
    expect(error).toMatchObject({
      _tag: "ProviderUnavailableError",
      providerId: "lando",
      operation: "logs",
      message:
        'No applied plan found for app "app". The provider does implement logs, but the app must be started first.',
      remediation:
        "Run `lando start` (or `lando app:start`) to start the app, then retry. Alternatively, pass an AppPlan directly via `target.plan`.",
    });
  });
  test("preserves the unavailable error fields with a concrete remediation", () => {
    const error = notImplementedError("lando", "exec");
    expect(error.message).toBe("provider-lando does not implement exec yet.");
    expect(error.providerId).toBe("lando");
    expect(error.operation).toBe("exec");
    expect(error.remediation).toBe(
      "Install or start the selected runtime provider, then re-run the failed command.",
    );
    expect(Object.hasOwn(error, "details")).toBe(false);
  });
  test("omits EventService when the host does not provide it", async () => {
    const inputs = await Effect.runPromise(providerHostInputs.pipe(Effect.provide(hostLayer)));
    expect(Object.hasOwn(inputs, "eventService")).toBe(false);
    expect(inputs.paths).toBe(paths);
    expect(inputs.platform).toBe("wsl");
    expect(inputs.resolveContainerHelper).toBe(resolveContainerHelper);
    expect(inputs.sanitizeAppliedPlan).toBe(sanitizeForPersistence);
  });
  test("keeps the provided EventService", async () => {
    const eventService = EventService.of({
      publish: () => Effect.void,
      subscribe: () => Stream.empty,
      subscribeQueue: Effect.die("unused"),
      waitFor: () => Effect.never,
      subscribeWithHistory: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    });
    const inputs = await Effect.runPromise(
      providerHostInputs.pipe(Effect.provide(hostLayer), Effect.provideService(EventService, eventService)),
    );
    expect(Object.hasOwn(inputs, "eventService")).toBe(true);
    expect(inputs.eventService).toBe(eventService);
  });
  test("omits dataPlane when there is no API", () => {
    const state = makeProviderPlanState(stateOptions);
    expect(Object.hasOwn(state, "dataPlane")).toBe(false);
    expect(state.appliedPlans.plans.size).toBe(0);
  });
  test("hands the provider's helper acquisition hook to the data plane", async () => {
    // Given: a provider that supplies an API and a pinned-helper acquisition hook.
    const pulled: string[] = [];
    const requests: string[] = [];
    const state = makeProviderPlanState({
      ...stateOptions,
      api: {
        request: (request) => {
          requests.push(request.path);
          return Effect.succeed({ status: 201, body: "{}" });
        },
      },
      pullHelperImage: (ref) =>
        Effect.sync(() => {
          pulled.push(ref);
          return { ref };
        }),
    });

    // When: a native snapshot needs its commit helper.
    const dataPlane = state.dataPlane;
    if (dataPlane === undefined) return expect(dataPlane).toBeDefined();
    const result = await Effect.runPromise(
      Effect.scoped(dataPlane.snapshotVolume({ volume: { app: plan.id, store: "data" } })).pipe(
        Effect.result,
      ),
    );

    // Then: the hook is asked for the digest ref, and its unverified answer blocks the helper.
    expect(pulled).toEqual([dataHelperImage.ref]);
    expect(result._tag).toBe("Failure");
    expect(requests.some((path) => path.startsWith("/containers/create"))).toBe(false);
  });

  test("binds execution-specific before callbacks to shared plan state", async () => {
    const state = makeProviderPlanState(stateOptions);
    await Effect.runPromise(rememberAppliedPlan(state.appliedPlans, plan, { reconcile: true }));
    const calls: string[] = [];
    const service = {
      lifecycle: () =>
        Effect.sync(() => {
          calls.push("service");
        }),
      waitForExit: () => Effect.die("unused"),
      exec: () => Effect.die("unused"),
      execStream: () => Stream.empty,
      inspect: () => Effect.die("unused"),
    };
    const first = bindResolvedProviderOps(state, {
      readAppEnvironment: () => Effect.succeed([]),
      ctx,
      service,
      noPlanError: (_app, op) => notImplementedError("lando", op),
      before: Effect.sync(() => {
        calls.push("first");
      }),
    });
    const second = bindResolvedProviderOps(state, {
      readAppEnvironment: () => Effect.succeed([]),
      ctx,
      service,
      noPlanError: (_app, op) => notImplementedError("lando", op),
      before: Effect.sync(() => {
        calls.push("second");
      }),
    });
    await Effect.runPromise(
      Effect.all(
        [
          first.start({ app: plan.id, service: ServiceName.make("web") }),
          second.start({ app: plan.id, service: ServiceName.make("web") }),
        ],
        { concurrency: 1 },
      ),
    );
    expect(calls).toEqual(["first", "service", "second", "service"]);
  });
});
