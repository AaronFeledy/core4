import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import { FileSyncEngine } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import {
  beginOrResumeAcceleratedStart,
  openJournal,
  readJournal,
} from "../../src/operations/accelerated-start-journal.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { applyTreeId } from "../../src/operations/start-progress.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { acceleratedPlan, app, recoveryHarness, target } from "./accelerated-start-recovery-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

const phases = ["preparing", "sessions-ready", "apply-intent"] as const;

test.each(
  phases.flatMap((phase) =>
    (["owned", "absent"] as const).flatMap((evidence) =>
      (["stop", "destroy"] as const).map((operation) => ({ phase, evidence, operation })),
    ),
  ),
)("top-level lifecycle handles pending first attempt with %j", async ({ phase, evidence, operation }) => {
  const harness = await Effect.runPromise(
    recoveryHarness({
      phase,
      harnessOptions: {
        resolveTeardownEvidence: () =>
          Effect.succeed(
            evidence === "absent"
              ? { kind: "absent" }
              : {
                  kind: "owned",
                  ownership: [
                    {
                      appRoot: app.root,
                      ownerKey: "owner",
                      providerId: acceleratedPlan.provider,
                      appIds: [acceleratedPlan.id],
                    },
                  ],
                },
          ),
        providerOverrides: {
          getStatus: Effect.succeed({ running: true }),
          cleanupOwnedResources: () =>
            Effect.succeed({ servicesRemoved: [], networksRemoved: 0, volumesRemoved: 0 }),
        },
      },
    }),
  );
  const result = await Effect.runPromiseExit(
    withResolvedCwd(
      app.root,
      operation === "stop" ? stopApp().pipe(Effect.asVoid) : destroyApp().pipe(Effect.asVoid),
    ).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isSuccess(result)).toBe(true);
  expect(harness.calls).toContain("drain");
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending?.phase).toBe(operation === "stop" ? phase : "completed");
});

test.each(["preparing", "sessions-ready"] as const)(
  "interrupted execution at %s resumes without replacing history",
  async (phase) => {
    let interrupt = true;
    const failOnce = () =>
      Effect.suspend(() => {
        if (!interrupt) return Effect.void;
        interrupt = false;
        return Effect.interrupt;
      });
    const harness = await Effect.runPromise(
      recoveryHarness({
        phase: "preparing",
        ...(phase === "preparing"
          ? { engineOverrides: { flushSession: failOnce } }
          : {
              harnessOptions: {
                onPublish: (event) =>
                  event._tag === "task.tree.start" && event.parentId === applyTreeId(String(app.id))
                    ? failOnce()
                    : Effect.void,
              },
            }),
      }),
    );
    const before = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    const failed = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
    expect(Exit.isFailure(failed) && Cause.hasInterrupts(failed.cause)).toBe(true);
    const interrupted = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(interrupted.pending?.phase).toBe(phase);
    await Effect.runPromise(startApp({}, target).pipe(Effect.provide(harness.layer)));
    const after = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(after.pending).toMatchObject({ attemptId: before.pending?.attemptId, phase: "completed" });
    expect(harness.sessions).toHaveLength(1);
    expect(harness.calls.some((call) => /^(create|terminate):/.test(call))).toBe(false);
  },
);

test("pre-apply resume creates only the genuinely missing session in a partial set", async () => {
  const existing = await Effect.runPromise(recoveryHarness());
  const engine = await Effect.runPromise(FileSyncEngine.pipe(Effect.provide(existing.layer)));
  const first = acceleratedPlan.fileSync[0];
  if (first === undefined || first.session.target._tag !== "volume")
    throw new TypeError("Expected volume session");
  const planned = {
    ...acceleratedPlan,
    fileSync: [
      first,
      {
        ...first,
        session: {
          ...first.session,
          mountKey: "second",
          target: { ...first.session.target, name: "second-volume" },
        },
      },
    ],
  };
  const harness = makeHarness({ plannedApp: planned, fileSync: engine });
  await Effect.runPromise(beginOrResumeAcceleratedStart(planned, app).pipe(Effect.provide(harness.layer)));
  await Effect.runPromise(startApp({}, { ...target, plan: planned }).pipe(Effect.provide(harness.layer)));
  expect(existing.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:two-way-safe"]);
  expect(existing.sessions).toHaveLength(2);
  expect(existing.sessions.map(({ ref }) => String(ref))).toContain("old");
});
const pendingHarness = Effect.fnUntraced(function* (phase: (typeof phases)[number]) {
  const harness = yield* recoveryHarness({ phase: "preparing", appliedState: "unknown" });
  const bucket = yield* openJournal(app).pipe(Effect.provide(harness.layer));
  yield* bucket.update((record) => {
    if (record === null) throw new TypeError("Expected pending journal");
    return { ...record, phase };
  });
  const { pending } = yield* readJournal(app).pipe(Effect.provide(harness.layer));
  return { ...harness, attemptId: pending?.attemptId };
});

test.each([...phases])(
  "unfinished %s attempt resumes the same sessions, including stop/manual-removal leftovers",
  async (phase) => {
    // Given a first unfinished attempt with durable session history.
    const harness = await Effect.runPromise(pendingHarness(phase));
    // When start replays the unfinished attempt.
    const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
    // Then it converges without terminating, duplicating, or reseeding history.
    expect(Exit.isSuccess(result)).toBe(true);
    const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(pending).toMatchObject({ attemptId: harness.attemptId, phase: "completed" });
    expect(harness.sessions).toHaveLength(acceleratedPlan.fileSync.length);
    expect(harness.calls.filter((call) => /^(terminate|create):/.test(call))).toEqual([]);
  },
);

test.each([...phases])("stop drains unfinished %s without completing the journal", async (phase) => {
  // Given an unfinished first attempt.
  const harness = await Effect.runPromise(pendingHarness(phase));
  // When stop is requested.
  const result = await Effect.runPromiseExit(stopApp({}, target).pipe(Effect.provide(harness.layer)));
  // Then durable history is drained, not disposed or forgotten.
  expect(Exit.isSuccess(result)).toBe(true);
  expect(harness.calls).toContain("drain");
  expect(harness.calls).not.toContain("dispose");
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending).toMatchObject({ attemptId: harness.attemptId, phase });
});

test.each([...phases])("destroy disposes unfinished %s in writer-safe order", async (phase) => {
  // Given an unfinished first attempt.
  const harness = await Effect.runPromise(pendingHarness(phase));
  // When destroy is requested.
  const result = await Effect.runPromiseExit(destroyApp({}, target).pipe(Effect.provide(harness.layer)));
  // Then disposal completes before provider destruction and the tombstone is written.
  expect(Exit.isSuccess(result)).toBe(true);
  expect(
    harness.calls.filter((call) =>
      ["drain", "dispose", "dispose-targets", "complete", "destroy:false"].includes(call),
    ),
  ).toEqual(["drain", "dispose", "dispose-targets", "complete", "destroy:false"]);
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending).toMatchObject({ attemptId: harness.attemptId, phase: "completed" });
});

for (const [name, operation] of [
  ["restart", restartApp],
  ["rebuild", rebuildApp],
] as const) {
  test.each([false, true])(
    `${name} resumes pending attempt before normal flow, selected=%s`,
    async (selected) => {
      // Given a pending first attempt.
      const harness = await Effect.runPromise(pendingHarness("apply-intent"));
      // When a full or selected-service lifecycle command runs.
      const result = await Effect.runPromiseExit(
        operation(selected ? { services: [ServiceName.make("web")] } : {}, target).pipe(
          Effect.provide(harness.layer),
        ),
      );
      // Then the pending attempt finishes before the requested flow succeeds.
      expect(Exit.isSuccess(result)).toBe(true);
      const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
      expect(pending?.phase).toBe("completed");
      expect(
        harness.calls.some((call) => call.startsWith("terminate:") || call === "create:one-way-replica"),
      ).toBe(false);
      expect(harness.events.filter((event) => event._tag === "pre-init")).toHaveLength(1);
    },
  );
}

test.each(["preparing", "sessions-ready"] as const)(
  "missing session is recreated before writers at %s",
  async (phase) => {
    // Given a pre-apply attempt whose session was never created.
    const harness = await Effect.runPromise(pendingHarness(phase));
    harness.sessions.splice(0);
    // When start resumes.
    const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
    // Then exactly the genuinely missing session is created in the planned mode.
    expect(Exit.isSuccess(result)).toBe(true);
    expect(harness.calls.filter((call) => call.startsWith("create:"))).toEqual(["create:two-way-safe"]);
    expect(harness.sessions).toHaveLength(1);
  },
);

test.each(["none", "history"] as const)(
  "apply-intent missing session recovery returns %s",
  async (recoverMissing) => {
    const harness = await Effect.runPromise(recoveryHarness({ recoverMissing }));
    harness.sessions.splice(0);
    const before = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
    expect(Exit.isSuccess(result)).toBe(recoverMissing === "history");
    expect(harness.calls).toContain("recover");
    expect(harness.calls.some((call) => /^(create|terminate|dispose)/.test(call))).toBe(false);
    const after = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(after.pending).toMatchObject({
      attemptId: before.pending?.attemptId,
      phase: recoverMissing === "history" ? "completed" : "apply-intent",
    });
    if (recoverMissing === "history") expect(harness.calls).toContain("flush:recovered");
  },
);

test("missing durable history after apply intent fails closed", async () => {
  // Given an apply-intent target whose durable history is missing.
  const harness = await Effect.runPromise(pendingHarness("apply-intent"));
  harness.sessions.splice(0);
  // When start resumes without a history recovery implementation.
  const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
  // Then the failure is tagged and neither session creation nor target disposal occurs.
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result))
    expect(Cause.findErrorOption(result.cause)).toMatchObject({
      value: {
        _tag: "FileSyncStartError",
        remediation:
          "Restore the session's synchronization history in the file-sync engine, then run `lando start`. Lando left the target untouched. `lando stop` still stops app writers; `lando destroy` refuses until the history is restored because the target may hold the only copy of app writes.",
      },
    });
  expect(harness.calls.filter((call) => /^(create|terminate|dispose)/.test(call))).toEqual([]);
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending?.phase).toBe("apply-intent");
});

test.each(phases.flatMap((phase) => (["owned", "absent"] as const).map((evidence) => ({ phase, evidence }))))(
  "stop drains first unfinished attempt with %j teardown evidence",
  async ({ phase, evidence }) => {
    const harness = await Effect.runPromise(
      recoveryHarness({
        phase,
        harnessOptions: {
          resolveTeardownEvidence: () =>
            Effect.succeed(
              evidence === "absent"
                ? { kind: "absent" }
                : {
                    kind: "owned",
                    ownership: [
                      {
                        appRoot: app.root,
                        ownerKey: "owner",
                        providerId: acceleratedPlan.provider,
                        appIds: [acceleratedPlan.id],
                      },
                    ],
                  },
            ),
          providerOverrides: {
            getStatus: Effect.succeed({ running: true }),
            cleanupOwnedResources: () =>
              Effect.succeed({ servicesRemoved: [], networksRemoved: 0, volumesRemoved: 0 }),
          },
        },
      }),
    );
    const result = await Effect.runPromiseExit(
      stopApp({}, { ...target, landofile: { name: "test-start", services: {} } }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(harness.calls).toContain("drain");
    const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(pending?.phase).toBe(phase);
  },
);

test.each(["preparing", "sessions-ready"] as const)(
  "destroy disposes %s targets whose session was never created",
  async (phase) => {
    const harness = await Effect.runPromise(recoveryHarness({ phase, appliedState: "unknown" }));
    harness.sessions.splice(0);
    const result = await Effect.runPromiseExit(destroyApp({}, target).pipe(Effect.provide(harness.layer)));
    expect(Exit.isSuccess(result)).toBe(true);
    // No session was ever created, so there is nothing to drain or dispose in the engine.
    expect(harness.calls).toEqual(["quiesce-retained", "dispose-targets", "destroy:false"]);
    const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(pending?.phase).toBe("completed");
  },
);

test("failed provider apply retains sessions and the next start resumes the same history", async () => {
  // Given a provider that fails its first apply after sessions are ready.
  let first = true;
  const harness = await Effect.runPromise(
    recoveryHarness({
      phase: "preparing",
      harnessOptions: {
        apply: () =>
          Effect.suspend(() => {
            if (first) {
              first = false;
              return Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "apply",
                  message: "apply failed",
                }),
              );
            }
            return Effect.succeed({ changed: true });
          }),
      },
    }),
  );
  const failed = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
  expect(Exit.isFailure(failed)).toBe(true);
  expect(harness.calls).not.toContain("drain");
  const before = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  // When start retries the retained attempt.
  const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
  // Then history survives and the same attempt completes.
  expect(Exit.isSuccess(result)).toBe(true);
  const after = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(after.pending).toMatchObject({ attemptId: before.pending?.attemptId, phase: "completed" });
  expect(harness.calls.filter((call) => /^(create|terminate):/.test(call))).toEqual([]);
});
