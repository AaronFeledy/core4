import { expect, test } from "bun:test";
import { ProviderUnavailableError, ProxyError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, FileSyncSessionRef } from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry, ToolingEngine } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { makeUnavailableRouter } from "../../src/subsystems/proxy/api.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { acceleratedPlan, app, session } from "./accelerated-start-recovery-support.ts";
import { recordingFileSync, secretRestartHarness } from "./app-activation-support.ts";
import { withAuthoredProjectEvents } from "./event-plan.ts";
import { recordingEngine } from "./event-recording-engine.ts";
import { oldPlan, ordinaryPlan } from "./start-file-sync-rotation-support.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const operation of [restartApp, rebuildApp]) {
  test(`${operation === restartApp ? "restart" : "rebuild"} relaunches a runtime that went away during the halt`, async () => {
    let running = true;
    const stored: AppPlan = { ...plan, stores: [{ name: "data", kind: "data", scope: "app" }] };
    const locator = {
      coordinationKey: "endpoint/data",
      nativeName: "data",
      identity: {
        coordinationKey: "endpoint/data",
        nativeName: "data",
        generation: "one",
        ownerRoot: stored.root,
        origin: "created" as const,
      },
    };
    const harness = makeHarness({
      plannedApp: stored,
      providerOverrides: {
        ensureReady: Effect.sync(() => {
          running = true;
        }),
      },
      onDestroy: () => {
        running = false;
      },
      locateVolume: () =>
        running
          ? Effect.succeed(locator)
          : Effect.fail(
              new ProviderUnavailableError({
                providerId: String(stored.provider),
                operation: "locateVolume",
                message: "The runtime is not running.",
                remediation: "Start the runtime.",
              }),
            ),
    });

    await Effect.runPromise(
      operation({}, { plan: stored, app, root: app.root }).pipe(Effect.provide(harness.layer)),
    );

    expect(running).toBe(true);
    expect(byTag(harness.events, "post-start")).toHaveLength(1);
  });

  test(`${operation === restartApp ? "restart" : "rebuild"} clears the halt drain before restarting accelerated services`, async () => {
    const calls: string[] = [];
    const fileSync = recordingFileSync(
      [
        {
          ...session,
          spec: session,
          ref: FileSyncSessionRef.make("retained"),
          status: "running" as const,
          lastUpdatedAt: DateTime.makeUnsafe("2026-01-01"),
        },
      ],
      calls,
    );
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      fileSync,
      appliedFileSyncState: "accelerated",
      onPublish: (event) =>
        Effect.sync(() => {
          if (event._tag === "post-stop" || event._tag === "pre-start") calls.push(event._tag);
        }),
    });

    await Effect.runPromise(
      operation({}, { plan: acceleratedPlan, app, root: app.root }).pipe(Effect.provide(harness.layer)),
    );

    expect(calls).toEqual(["invalidate", "drain", "post-stop", "invalidate", "pre-start"]);
  });

  test(`${operation === restartApp ? "restart" : "rebuild"} rotates changed file sync after halting the app`, async () => {
    const calls: string[] = [];
    const sessions = oldPlan.fileSync.map(({ session }) => ({
      ...session,
      spec: session,
      ref: FileSyncSessionRef.make(String(session.service)),
      status: "running" as const,
      lastUpdatedAt: DateTime.makeUnsafe("2026-01-01"),
    }));
    let applied = true;
    const harness = makeHarness({
      plannedApp: ordinaryPlan,
      fileSync: recordingFileSync(sessions, calls),
      onPublish: (event) =>
        Effect.sync(() => {
          if (event._tag === "post-stop" || event._tag === "pre-start") calls.push(event._tag);
        }),
      resolveAppliedPlan: () => Effect.sync(() => (applied ? oldPlan : undefined)),
      onDestroy: (_target, options) => {
        if (options?.removeState === true) {
          applied = false;
          calls.push("retire");
        }
      },
      disposeFileSyncTargets: () => Effect.void,
    });
    const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());

    await Effect.runPromise(
      operation({}, { plan: ordinaryPlan, app, root: app.root }).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...harness.runtimeProviderRegistry,
          select: () =>
            Effect.succeed({
              ...provider,
              inspectAppliedFileSync: () =>
                Effect.sync(() =>
                  applied
                    ? {
                        status: "accelerated" as const,
                        engineId: "mutagen",
                        sessions: oldPlan.fileSync.map(({ session }) => session),
                      }
                    : { status: "missing" as const },
                ),
            }),
        }),
        Effect.provide(harness.layer),
      ),
    );

    expect(calls).toEqual(["invalidate", "drain", "post-stop", "drain", "dispose", "retire", "pre-start"]);
  });

  test(`${operation === restartApp ? "restart" : "rebuild"} refuses a volume reassigned by a post-stop hook before pre-start`, async () => {
    let ownerRoot = plan.root;
    const plannedApp = withAuthoredProjectEvents(
      {
        ...plan,
        stores: [{ name: "data", kind: "data", scope: "app" }],
      },
      { "post-stop": ["{{ event._tag }}"] },
    );
    const harness = makeHarness({
      plannedApp,
      locateVolume: () =>
        Effect.sync(() => ({
          coordinationKey: "endpoint/data",
          nativeName: "data",
          identity: {
            coordinationKey: "endpoint/data",
            nativeName: "data",
            generation: "one",
            ownerRoot,
            origin: "created" as const,
          },
        })),
    });
    const executed: string[] = [];

    const error = await Effect.runPromise(
      operation(
        {},
        {
          plan: plannedApp,
          app,
          root: app.root,
          landofile: literalTestLandofile({ name: plannedApp.name, services: {} }, plannedApp.root),
        },
      ).pipe(
        Effect.provideService(
          ToolingEngine,
          recordingEngine(executed, undefined, (name) => {
            if (name === "'post-stop'") ownerRoot = AbsolutePath.make(`${plan.root}/other`);
          }),
        ),
        Effect.provide(harness.layer),
        Effect.flip,
      ),
    );

    expect(error._tag).toBe("VolumeOperationError");
    expect(executed).toEqual(["'post-stop'"]);
    expect(byTag(harness.events, "pre-start")).toEqual([]);
  });
}

test("a routed restart refuses an unselectable router before an invalid file-sync engine", async () => {
  const desired: AppPlan = {
    ...acceleratedPlan,
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
    fileSync: [{ engineId: "missing", session }],
  };
  const harness = makeHarness({ plannedApp: desired });

  const error = await Effect.runPromise(
    restartApp({}, { plan: desired, app, root: app.root }).pipe(
      Effect.provideService(
        RouterService,
        makeUnavailableRouter(
          new ProxyError({
            proxyId: "missing",
            message: "Unavailable",
            remediation: "Select a router.",
          }),
        ),
      ),
      Effect.provide(harness.layer),
      Effect.flip,
    ),
  );

  expect(error._tag).toBe("ProxySetupError");
  expect(byTag(harness.events, "pre-init")).toEqual([]);
});

test("an in-place selected restart resolves no secret", async () => {
  const harness = secretRestartHarness();
  const desired = harness.desired;

  const result = await Effect.runPromise(
    restartApp(
      { services: [web.name] },
      {
        plan: desired,
        root: desired.root,
        app: { kind: "user", id: desired.id, root: desired.root },
      },
    ).pipe(Effect.provide(harness.layer)),
  );

  expect(result.servicesStarted.map((service) => service.name)).toEqual([web.name]);
  expect(harness.mutations).toEqual(["stop", "start"]);
  expect(harness.resolutions()).toBe(0);
});
