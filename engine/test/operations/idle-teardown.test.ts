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

test.each(["stop", "destroy", "destroy-root"] as const)(
  "%s handles idle ownership inventory without mistaking it for absence",
  async (operation) => {
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

test("idle stop preserves durable sessions and the unfinished apply-intent journal", async () => {
  const harness = await Effect.runPromise(
    recoveryHarness({
      harnessOptions: {
        appliedPlans: [acceleratedPlan],
        providerOverrides: { getStatus: Effect.succeed({ state: "idle" }) },
      },
    }),
  );
  const result = await Effect.runPromise(stopAppForTarget({}, target).pipe(Effect.provide(harness.layer)));
  expect(result.outcome).toBe("stopped");
  expect(harness.calls).toEqual([]);
  expect(harness.sessions.map(({ ref }) => String(ref))).toEqual(["old"]);
  const journal = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(journal.pending?.phase).toBe("apply-intent");
});

test.each(["identity", "inventory"] as const)(
  "idle stop rejects mismatched %s before host mutation",
  async (mismatch) => {
    const mutations: string[] = [];
    const harness = await Effect.runPromise(
      recoveryHarness({
        extraSession: mismatch === "inventory",
        harnessOptions: {
          appliedPlans: [acceleratedPlan],
          providerOverrides: { getStatus: Effect.succeed({ state: "idle" }) },
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
  },
);

test("idle stop terminates listed lifecycle-less sessions without flushing runtime endpoints", async () => {
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
    appliedFileSyncState: "accelerated",
    providerOverrides: { getStatus: Effect.succeed({ state: "idle" }) },
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
});

test("idle stop does not require a file-sync observation the stopped runtime cannot provide", async () => {
  const actions: string[] = [];
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    isAvailable: Effect.succeed(true),
    getStatus: Effect.succeed({ state: "idle" as const }),
    ensureReady: Effect.sync(() => {
      actions.push("ensure-ready");
    }),
    // A Windows provider probes managed volumes through the stopped machine and cannot answer.
    inspectAppliedFileSync: () => Effect.succeed({ status: "unknown" as const }),
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
});
