import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, FileSyncSessionRef, appIdentityKey } from "@lando/sdk/schema";
import { TestFileSyncEngine, TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, DateTime, Effect, Exit, Option } from "effect";
import { openJournal, readJournal } from "../../src/operations/accelerated-start-journal.ts";
import { destroyAppAtRoot, destroyAppForTarget } from "../../src/operations/destroy.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { resolveTeardownEvidence } from "../../src/providers/applied-state-resolution.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import {
  acceleratedPlan,
  app,
  recoveryHarness,
  session,
  target,
} from "./accelerated-start-recovery-support.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";
import { stoppedProviderFixtures, stoppedProviderInspection } from "./stopped-provider-support.ts";

test.each(
  stoppedProviderFixtures.flatMap((fixture) =>
    (["stop", "destroy", "destroy-root"] as const).map((operation) => ({ fixture, operation })),
  ),
)(
  "$operation handles $fixture ownership inventory without mistaking it for absence",
  async ({ operation, fixture }) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-idle-teardown-")));
    try {
      const root = AbsolutePath.make(join(base, "removed-app"));
      if (operation !== "destroy-root") await mkdir(root);
      const applied = { ...plan, root, identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) } };
      const hints = {
        appRoot: root,
        ownerKey: applied.identity.ownerKey,
        providerId: applied.provider,
        appIds: [applied.id],
      };
      let running = false;
      let preparations = 0;
      const actions: string[] = [];
      const provider = {
        ...TestRuntimeProvider,
        id: "lando",
        isAvailable: Effect.succeed(true),
        getStatus: Effect.sync(() => ({ state: running ? ("running" as const) : ("idle" as const) })),
        ensureReady: Effect.sync(() => {
          preparations += 1;
          running = true;
        }),
        appliedPlans: Effect.succeed([applied]),
        runtimeOnline: Effect.sync(() => running),
        inspectAppliedFileSync: stoppedProviderInspection(fixture, () => running),
        canCleanupOwnedResources: Effect.succeed(true),
        resourceOwnership: () => Effect.succeed(hints),
        cleanupOwnedResources: () =>
          Effect.sync(() => {
            if (!running) throw new Error("ownership cleanup needs readiness");
            actions.push("cleanup");
            return { servicesRemoved: [], networksRemoved: 1, volumesRemoved: 0 };
          }),
        destroy: () =>
          Effect.sync(() => {
            if (!running) throw new Error("destroy needs readiness");
            actions.push("destroy");
            return { kind: "destroyed" as const };
          }),
      };
      const harness = makeHarness({
        plannedApp: applied,
        appliedPlans: [applied],
        selectProvider: () => Effect.succeed(provider),
        resolveAppliedPlan: () => Effect.succeed(applied),
        resolveTeardownEvidence: (root) => resolveTeardownEvidence(root, [provider]),
      });
      const target = { plan: applied, root, app: { kind: "user" as const, id: applied.id, root } };
      const effect =
        operation === "stop"
          ? stopAppForTarget({}, target).pipe(Effect.map((result) => result.outcome))
          : operation === "destroy"
            ? destroyAppForTarget({ yes: true }, target).pipe(Effect.map((result) => result.outcome))
            : destroyAppAtRoot(root, { yes: true }).pipe(Effect.map((result) => result.outcome));
      const result = await Effect.runPromise(
        effect.pipe(Effect.provide(harness.layer), Effect.provide(BunFileSystem.layer)),
      );
      expect(result).toBe(operation === "stop" ? "stopped" : "destroyed");
      expect(preparations).toBe(operation === "stop" ? 0 : 1);
      expect(actions).toEqual(operation === "stop" ? [] : ["destroy", "cleanup"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);

test.each(stoppedProviderFixtures)(
  "%s stop preserves durable sessions and the unfinished apply-intent journal",
  async (fixture) => {
    const harness = await Effect.runPromise(
      recoveryHarness({
        harnessOptions: {
          appliedPlans: [acceleratedPlan],
          providerCanInspectFileSync: false,
          providerOverrides: {
            getStatus: Effect.succeed({ state: "idle" }),
            inspectAppliedFileSync: stoppedProviderInspection(fixture, () => false),
          },
        },
      }),
    );
    const result = await Effect.runPromise(stopAppForTarget({}, target).pipe(Effect.provide(harness.layer)));
    expect(result.outcome).toBe("stopped");
    expect(harness.calls).toEqual([]);
    expect(harness.sessions.map(({ ref }) => String(ref))).toEqual(["old"]);
    const journal = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(journal.pending?.phase).toBe("apply-intent");
  },
);

test.each(
  stoppedProviderFixtures.flatMap((fixture) =>
    (["identity", "inventory"] as const).map((mismatch) => ({ fixture, mismatch })),
  ),
)("$fixture stop rejects mismatched $mismatch before host mutation", async ({ fixture, mismatch }) => {
  const mutations: string[] = [];
  const harness = await Effect.runPromise(
    recoveryHarness({
      extraSession: mismatch === "inventory",
      harnessOptions: {
        appliedPlans: [acceleratedPlan],
        providerCanInspectFileSync: false,
        providerOverrides: {
          getStatus: Effect.succeed({ state: "idle" }),
          inspectAppliedFileSync: stoppedProviderInspection(fixture, () => false),
        },
        onRemoveRoutes: () => mutations.push("routes"),
        onPublish: (event) => Effect.sync(() => mutations.push(event._tag)),
      },
    }),
  );
  if (mismatch === "identity")
    await Effect.runPromise(
      openJournal(app).pipe(
        Effect.flatMap((bucket) =>
          bucket.mutate((current) =>
            current === null
              ? Effect.die("missing journal fixture")
              : Effect.succeed({
                  _tag: "Set",
                  value: { ...current, providerId: "other" },
                  result: undefined,
                }),
          ),
        ),
        Effect.provide(harness.layer),
      ),
    );
  const result = await Effect.runPromiseExit(
    stopAppForTarget({}, target).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    const error = Option.getOrThrow(Cause.findErrorOption(result.cause));
    expect(error._tag).toBe("FileSyncStopError");
    expect(error.message).toContain(
      mismatch === "identity" ? "identity changed" : "Unknown file-sync sessions",
    );
  }
  expect(mutations).toEqual([]);
  expect(harness.calls).toEqual([]);
});

test.each(stoppedProviderFixtures)(
  "%s stop terminates listed lifecycle-less sessions without flushing runtime endpoints",
  async (fixture) => {
    const sessions = [
      {
        ...session,
        ref: FileSyncSessionRef.make("legacy"),
        spec: session,
        status: "running" as const,
        lastUpdatedAt: DateTime.makeUnsafe("2026-01-01"),
      },
    ];
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      appliedPlans: [acceleratedPlan],
      providerCanInspectFileSync: false,
      providerOverrides: {
        getStatus: Effect.succeed({ state: "idle" }),
        inspectAppliedFileSync: stoppedProviderInspection(
          fixture,
          () => false,
          Effect.succeed({ status: "accelerated", engineId: "mutagen", sessions: [session] }),
        ),
      },
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () => Effect.succeed(sessions),
        flushSession: () => Effect.die("idle stop must not flush a runtime endpoint"),
        terminateSession: (ref) =>
          Effect.sync(() => {
            const index = sessions.findIndex((session) => session.ref === ref);
            if (index >= 0) sessions.splice(index, 1);
          }),
      },
    });
    await Effect.runPromise(stopAppForTarget({}, target).pipe(Effect.provide(harness.layer)));
    expect(sessions).toEqual([]);
  },
);

test.each(stoppedProviderFixtures)(
  "%s stop does not require a file-sync observation the stopped runtime cannot provide",
  async (fixture) => {
    const actions: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      isAvailable: Effect.succeed(true),
      getStatus: Effect.succeed({ state: "idle" as const }),
      ensureReady: Effect.sync(() => {
        actions.push("ensure-ready");
      }),
      inspectAppliedFileSync: stoppedProviderInspection(fixture, () => false),
      appliedPlans: Effect.succeed([plan]),
      runtimeOnline: Effect.succeed(false),
      destroy: () =>
        Effect.sync(() => {
          actions.push("destroy");
          return { kind: "destroyed" as const };
        }),
    };
    const harness = makeHarness({
      plannedApp: plan,
      appliedPlans: [plan],
      selectProvider: () => Effect.succeed(provider),
      resolveAppliedPlan: () => Effect.succeed(plan),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "applied" as const, plan }),
    });
    const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };

    const result = await Effect.runPromise(
      stopAppForTarget({}, target).pipe(Effect.provide(harness.layer), Effect.provide(BunFileSystem.layer)),
    );

    expect(result.outcome).toBe("stopped");
    expect(actions).toEqual([]);
  },
);
