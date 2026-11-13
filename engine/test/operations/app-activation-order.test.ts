import { describe, expect, test } from "bun:test";
import { ManagedFileTransactionError, ProviderUnavailableError, ProxyError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, PortablePath } from "@lando/sdk/schema";
import {
  ManagedFileTransactionGuard,
  RouterService,
  RuntimeProviderRegistry,
  physicalVolumeLockKey,
} from "@lando/sdk/services";
import { Effect, type Layer } from "effect";
import type { ResolvedAppTarget } from "../../src/landofile/app-resolution.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { makeUnavailableRouter } from "../../src/subsystems/proxy/api.ts";
import { acceleratedPlan, session } from "./accelerated-start-recovery-support.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const coordinationKey = "endpoint/data";
const stored: AppPlan = { ...plan, stores: [{ name: "data", kind: "data", scope: "app" }] };
const lifecycleEvents = new Set([
  "pre-init",
  "post-init",
  "pre-restart",
  "post-restart",
  "pre-rebuild",
  "post-rebuild",
  "pre-stop",
  "post-stop",
  "pre-start",
  "post-start",
]);

type HarnessServices = Layer.Success<ReturnType<typeof makeHarness>["layer"]>;

interface Fault {
  readonly plannedApp?: AppPlan;
  readonly router?: typeof RouterService.Service;
  readonly ensureReady?: Effect.Effect<void, ProviderUnavailableError>;
  readonly volumeOwner?: AbsolutePath;
  readonly transactionCheck?: Effect.Effect<void, ManagedFileTransactionError>;
}

/** Runs one operation and records the calls an admission step makes that a provider, registry, or subscriber can see. */
const traced = async (
  operation: (
    target: ResolvedAppTarget,
  ) => Effect.Effect<unknown, { readonly _tag: string }, HarnessServices>,
  fault: Fault = {},
) => {
  const trace: string[] = [];
  const mark = (step: string) => {
    if (trace.at(-1) !== step) trace.push(step);
  };
  const plannedApp = fault.plannedApp ?? stored;
  const harness = makeHarness({
    plannedApp,
    providerOverrides: {
      ensureReady: Effect.sync(() => mark("ensureReady")).pipe(
        Effect.andThen(fault.ensureReady ?? Effect.void),
      ),
    },
    onVolumeLock: (key) => {
      if (key === physicalVolumeLockKey(coordinationKey)) mark("volume lock");
    },
    onPublish: (event) =>
      Effect.sync(() => {
        if (lifecycleEvents.has(event._tag)) mark(event._tag);
      }),
    onApply: () => mark("apply"),
    onDestroy: () => mark("halt"),
    onStop: () => mark("stop service"),
    locateVolume: (ref) =>
      Effect.succeed({
        coordinationKey,
        nativeName: ref.store,
        identity: {
          coordinationKey,
          nativeName: ref.store,
          generation: "one",
          ownerRoot: fault.volumeOwner ?? plannedApp.root,
          origin: "created" as const,
        },
      }),
  });
  const registry = harness.runtimeProviderRegistry;
  const error = await Effect.runPromise(
    operation({
      plan: plannedApp,
      root: plannedApp.root,
      app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
    }).pipe(
      Effect.provideService(RuntimeProviderRegistry, {
        ...registry,
        appliedPlansFor: (root: AbsolutePath) =>
          Effect.sync(() => mark("applied state")).pipe(Effect.andThen(registry.appliedPlansFor(root))),
      }),
      Effect.provideService(ManagedFileTransactionGuard, {
        assertReadable: () => Effect.void,
        ensureConsistent: () =>
          Effect.sync(() => mark("transaction check")).pipe(
            Effect.andThen(fault.transactionCheck ?? Effect.void),
          ),
        pending: () => Effect.succeed(null),
      }),
      fault.router === undefined ? (effect) => effect : Effect.provideService(RouterService, fault.router),
      Effect.provide(harness.layer),
      Effect.match({ onFailure: (failure) => failure._tag, onSuccess: () => undefined }),
    ),
  );
  return { trace, error };
};

// Every operation runs the same admission before its own body: reconcile and placement read
// applied state, the runtime is prepared, volumes are locked, the transaction check runs, then init.
const admission = [
  "applied state",
  "ensureReady",
  "volume lock",
  "transaction check",
  "pre-init",
  "post-init",
];
const haltAndRelaunch = [
  "applied state",
  "pre-stop",
  "halt",
  "post-stop",
  "ensureReady",
  "pre-start",
  "apply",
  "post-start",
];

const operations = {
  start: (target: ResolvedAppTarget) => startApp({}, target),
  restart: (target: ResolvedAppTarget) => restartApp({}, target),
  rebuild: (target: ResolvedAppTarget) => rebuildApp({}, target),
  "restart --service": (target: ResolvedAppTarget) => restartApp({ services: [web.name] }, target),
  "rebuild --service": (target: ResolvedAppTarget) => rebuildApp({ services: [web.name] }, target),
};

test.each([
  ["start", ["pre-start", "apply", "post-start"]],
  ["restart", ["pre-restart", ...haltAndRelaunch, "post-restart"]],
  ["rebuild", ["pre-rebuild", ...haltAndRelaunch, "post-rebuild"]],
  ["restart --service", ["pre-restart", "stop service", "apply", "post-restart"]],
  ["rebuild --service", ["pre-rebuild", "stop service", "apply", "post-rebuild"]],
] as const)("%s runs the shared admission and then its own body", async (name, body) => {
  const { trace, error } = await traced(operations[name]);

  expect(error).toBeUndefined();
  expect(trace).toEqual([...admission, ...body]);
});

const routed: AppPlan = {
  ...stored,
  routes: [
    {
      hostname: "web.test",
      priority: 2,
      scheme: "https",
      service: web.name,
      endpoint: 3000,
      backend: { service: web.name, protocol: "http", port: 3000 },
    },
  ],
};
const invalidOverlay: AppPlan = {
  ...stored,
  services: {
    [web.name]: {
      ...web,
      extensions: { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } },
      mounts: [
        {
          type: "bind",
          source: "/authored",
          target: PortablePath.make("/usr/local/bin/lando"),
          readOnly: true,
          realization: "passthrough",
          origin: "authored",
        },
      ],
    },
  },
};
const unknownEngine: AppPlan = {
  ...acceleratedPlan,
  stores: stored.stores,
  fileSync: [{ engineId: "missing", session }],
};
const unavailable = new ProviderUnavailableError({
  providerId: String(stored.provider),
  operation: "ensureReady",
  message: "The runtime cannot start.",
  remediation: "Run lando setup.",
});

// Each row fails one admission step and lists the observable steps that ran first.
const refusals: ReadonlyArray<readonly [step: string, fault: Fault, error: string, ranFirst: string[]]> = [
  [
    "an unselectable router",
    {
      plannedApp: routed,
      router: makeUnavailableRouter(
        new ProxyError({ proxyId: "missing", message: "Unavailable", remediation: "Select a router." }),
      ),
    },
    "ProxySetupError",
    ["applied state"],
  ],
  [
    "a file-sync engine that is not installed",
    { plannedApp: unknownEngine },
    "FileSyncStartError",
    ["applied state"],
  ],
  [
    "an invalid overlay",
    { plannedApp: invalidOverlay },
    "HostProxyTransportUnavailableError",
    ["applied state"],
  ],
  [
    "a runtime that cannot be prepared",
    { ensureReady: Effect.fail(unavailable) },
    "ProviderUnavailableError",
    ["applied state", "ensureReady"],
  ],
  [
    "a volume another app owns",
    { volumeOwner: AbsolutePath.make(`${stored.root}/other`) },
    "VolumeOperationError",
    ["applied state", "ensureReady"],
  ],
  [
    "an unfinished managed-file transaction",
    {
      transactionCheck: Effect.fail(
        new ManagedFileTransactionError({
          reason: "blocked",
          phase: "inspect",
          path: String(stored.root),
          cause: "invariant",
          remediation: "Finish the pending transaction.",
        }),
      ),
    },
    "ManagedFileTransactionError",
    ["applied state", "ensureReady", "volume lock", "transaction check"],
  ],
];

describe.each(["start", "restart", "rebuild"] as const)("%s admission", (name) => {
  test.each(refusals)("refuses %s before any later step", async (_step, fault, error, ranFirst) => {
    const result = await traced(operations[name], fault);

    expect(result.error).toBe(error);
    expect(result.trace).toEqual(ranFirst);
  });
});
