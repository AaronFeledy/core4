import { expect, test } from "bun:test";
import { FileSyncSessionRef, ProviderId } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Schema } from "effect";
import {
  beginAcceleratedStart,
  openJournal,
  readJournal,
  requireNoPendingAcceleratedStart,
} from "../../src/operations/accelerated-start-journal.ts";
import { PendingStart } from "../../src/operations/accelerated-start-record.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { acceleratedPlan, app, recoveryHarness, target } from "./accelerated-start-recovery-support.ts";

const phases = ["preparing", "sessions-ready", "apply-intent"] as const;
const interruptedRecovery = Effect.fnUntraced(function* (phase: (typeof phases)[number]) {
  const harness = yield* recoveryHarness();
  const original = yield* readJournal(app).pipe(Effect.provide(harness.layer));
  const adopted = yield* beginAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer));
  if (phase !== "preparing") yield* adopted.phase("sessions-ready");
  if (phase === "apply-intent") yield* adopted.phase("apply-intent");
  return { ...harness, original: original.pending, adopted };
});

test("version-1 journals without a recovery marker still decode", async () => {
  // Given an original version-1 journal without an adoption marker.
  const harness = await Effect.runPromise(recoveryHarness());
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  if (pending === null) throw new Error("Expected retained journal");
  const legacy = {
    attemptId: pending.attemptId,
    appId: pending.appId,
    appRoot: pending.appRoot,
    providerId: pending.providerId,
    engineId: pending.engineId,
    mountPlanDigest: pending.mountPlanDigest,
    phase: pending.phase,
    targets: pending.targets,
    sessions: pending.sessions,
  };
  // When the current schema decodes the legacy payload.
  const decoded = Schema.decodeUnknownSync(PendingStart)(legacy);
  // Then the complete ownership record is preserved without needing a migration.
  expect(decoded).toEqual(legacy);
});

test("adoption durably marks recovery and preserves its origin across another adoption", async () => {
  // Given a recovery killed immediately after its adoption write.
  const harness = await Effect.runPromise(interruptedRecovery("preparing"));
  const before = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(before.pending).toHaveProperty("recoveredFrom", harness.original?.attemptId);
  // When the next process adopts the interrupted recovery.
  const retry = await Effect.runPromise(
    beginAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer)),
  );
  // Then its new attempt ID keeps the original recovery lineage durably.
  const after = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(retry.attemptId).not.toBe(harness.adopted.attemptId);
  expect(after.pending).toMatchObject({ attemptId: retry.attemptId, phase: "preparing" });
  expect(after.pending).toHaveProperty("recoveredFrom", harness.original?.attemptId);
});

test.each(
  phases.flatMap((phase) =>
    (["one-way-replica", "two-way-safe"] as const).flatMap((mode) =>
      ["start", "destroy"].map((operation) => ({ phase, mode, operation })),
    ),
  ),
)(
  "interrupted recovery preserves exact session history or fails closed: %j",
  async ({ phase, mode, operation }) => {
    const harness = await Effect.runPromise(interruptedRecovery(phase));
    const previous = harness.sessions[0];
    if (previous === undefined) throw new Error("Expected surviving session");
    const spec = { ...previous.spec, mode };
    harness.sessions.splice(0, 1, { ...previous, ref: FileSyncSessionRef.make("interrupted"), spec });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return operation === "start"
          ? yield* Effect.exit(startApp({}, target))
          : yield* Effect.exit(destroyApp({}, target));
      }).pipe(Effect.provide(harness.layer)),
    );
    const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    if (mode === "one-way-replica") {
      expect(result._tag).toBe("Failure");
      expect(harness.calls).not.toContain("terminate:interrupted");
      expect(harness.calls).not.toContain("flush:interrupted");
      expect(harness.sessions).toHaveLength(1);
      expect(pending?.phase).not.toBe("completed");
      return;
    }
    expect(result._tag).toBe("Success");
    expect(harness.calls).not.toContain("terminate:interrupted");
    if (operation === "start") {
      expect(harness.calls).not.toContain("create:one-way-replica");
      expect(harness.calls).toContain("flush:interrupted");
      expect(harness.sessions).toHaveLength(1);
    } else {
      expect(harness.calls).toContain("quiesce-retained");
      expect(harness.calls).toContain("drain");
      expect(harness.calls).toContain("dispose");
      expect(harness.calls).toContain("dispose-targets");
      expect(harness.sessions).toHaveLength(0);
    }
    expect(pending?.phase).toBe("completed");
    expect(
      await Effect.runPromise(
        requireNoPendingAcceleratedStart(app, acceleratedPlan, true).pipe(Effect.provide(harness.layer)),
      ),
    ).toBeUndefined();
  },
);

test("a fresh attempt does not inherit a completed recovery marker", async () => {
  // Given a completed recovery record.
  const harness = await Effect.runPromise(interruptedRecovery("preparing"));
  await Effect.runPromise(harness.adopted.clear);
  // When an independent start begins later.
  await Effect.runPromise(beginAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer)));
  // Then the new attempt remains an ordinary pending start with no recovery privilege.
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending).not.toHaveProperty("recoveredFrom");
  const guard = await Effect.runPromiseExit(
    requireNoPendingAcceleratedStart(app, acceleratedPlan, true).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isFailure(guard)).toBe(true);
});

test.each([...phases])("unmarked %s journals still block start and destroy", async (phase) => {
  // Given an unfinished first attempt, not a recovery.
  const harness = await Effect.runPromise(recoveryHarness({ phase: "preparing" }));
  const bucket = await Effect.runPromise(openJournal(app).pipe(Effect.provide(harness.layer)));
  await Effect.runPromise(
    bucket.update((pending) => {
      if (pending === null) throw new Error("Expected pending journal");
      return { ...pending, phase };
    }),
  );
  // When either escape hatch is attempted.
  const results = await Effect.runPromise(
    Effect.all([Effect.exit(startApp({}, target)), Effect.exit(destroyApp({}, target))]).pipe(
      Effect.provide(harness.layer),
    ),
  );
  // Then neither operation mutates sessions or provider resources.
  expect(results.every((result) => result._tag === "Failure")).toBe(true);
  const startResult = results[0];
  if (startResult?._tag === "Failure") {
    const failure = Cause.findErrorOption(startResult.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some")
      expect(failure.value).toMatchObject({
        remediation: expect.stringContaining("Start and destroy remain blocked"),
      });
  }
  expect(harness.calls).toEqual([]);
});

test.each([...phases])("stop, restart and rebuild remain blocked during recovery phase %s", async (phase) => {
  // Given an interrupted recovery.
  const harness = await Effect.runPromise(interruptedRecovery(phase));
  // When non-recovery lifecycle operations are requested.
  const results = await Effect.runPromise(
    Effect.all([
      Effect.exit(stopApp({}, target)),
      Effect.exit(restartApp({}, target)),
      Effect.exit(rebuildApp({}, target)),
    ]).pipe(Effect.provide(harness.layer)),
  );
  // Then all three reject the pending journal without touching sessions.
  expect(results.every((result) => result._tag === "Failure")).toBe(true);
  for (const result of results)
    if (result._tag === "Failure") expect(Cause.pretty(result.cause)).toContain("interrupted recovery");
  expect(harness.calls).toEqual([]);
});

test.each(["provider", "engine", "digest"] as const)(
  "interrupted recovery still checks %s",
  async (changed) => {
    // Given an interrupted recovery and a changed plan.
    const harness = await Effect.runPromise(interruptedRecovery("preparing"));
    const plans = {
      provider: { ...acceleratedPlan, provider: ProviderId.make("other") },
      engine: {
        ...acceleratedPlan,
        fileSync: acceleratedPlan.fileSync.map((entry) => ({ ...entry, engineId: "other" })),
      },
      digest: {
        ...acceleratedPlan,
        fileSync: acceleratedPlan.fileSync.map((entry) => ({
          ...entry,
          session: { ...entry.session, excludes: ["changed"] },
        })),
      },
    };
    // When adoption evaluates the changed built plan.
    const result = await Effect.runPromiseExit(
      beginAcceleratedStart(plans[changed], app).pipe(Effect.provide(harness.layer)),
    );
    // Then it refuses adoption and preserves the existing attempt.
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(`${changed} changed`);
    const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(pending?.attemptId).toBe(harness.adopted.attemptId);
  },
);
