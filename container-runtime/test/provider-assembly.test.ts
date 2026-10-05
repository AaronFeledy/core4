import { describe, expect, test } from "bun:test";
import { AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanSanitizer, EventService, LogFileHelperAssets, PathsService } from "@lando/sdk/services";
import { Effect, Layer, Schema, Stream } from "effect";
import {
  bindResolvedProviderOps,
  forgetAppliedPlanUnlessKept,
  makeProviderPlanState,
  noPlanErrorFactory,
  notImplementedError,
  providerHostInputs,
  rememberAppliedPlan,
} from "../src/provider-assembly.ts";

const plan = Schema.decodeSync(AppPlan)({
  id: "app",
  name: "app",
  slug: "app",
  root: "/app",
  provider: "lando",
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
});
const ctx = { providerId: "lando", remediation: "Retry." };
const stateOptions = {
  ctx,
  providerId: ProviderId.make("lando"),
  providerName: "provider-lando",
  snapshotMode: "native" as const,
  redactDetails: (value: unknown) => value,
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
  appSnapshotsDir: () => "",
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
const payloads = { "linux-arm64": new Uint8Array([1, 2, 3]) };
const sanitizeForPersistence = (value: AppPlan) => ({ ...value, name: "sanitized" });
const hostLayer = Layer.mergeAll(
  Layer.succeed(PathsService, paths),
  Layer.succeed(LogFileHelperAssets, { payloads: Effect.succeed(payloads) }),
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
  test("preserves the unavailable error without adding optional fields", () => {
    const error = notImplementedError("lando", "exec");
    expect(error.message).toBe("provider-lando does not implement exec yet.");
    expect(error.providerId).toBe("lando");
    expect(error.operation).toBe("exec");
    expect(Object.hasOwn(error, "remediation")).toBe(false);
    expect(Object.hasOwn(error, "details")).toBe(false);
  });
  test("omits EventService when the host does not provide it", async () => {
    const inputs = await Effect.runPromise(providerHostInputs.pipe(Effect.provide(hostLayer)));
    expect(Object.hasOwn(inputs, "eventService")).toBe(false);
    expect(inputs.paths).toBe(paths);
    expect(inputs.platform).toBe("wsl");
    expect(inputs.logFileHelperPayloads).toBe(payloads);
    expect(inputs.sanitizeAppliedPlan).toBe(sanitizeForPersistence);
  });
  test("keeps the provided EventService", async () => {
    const eventService = EventService.of({
      publish: () => Effect.void,
      subscribe: () => Stream.empty,
      subscribeQueue: Effect.die("unused"),
      waitFor: () => Effect.never,
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
      ctx,
      service,
      noPlanError: (_app, op) => notImplementedError("lando", op),
      before: Effect.sync(() => {
        calls.push("first");
      }),
    });
    const second = bindResolvedProviderOps(state, {
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
