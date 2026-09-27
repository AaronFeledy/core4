import { expect, test } from "bun:test";
import { ProviderId } from "@lando/sdk/schema";
import { BuildOrchestrator } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";
import {
  beginAcceleratedStart,
  readJournal,
  requireNoPendingAcceleratedStart,
} from "../../src/operations/accelerated-start-journal.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopApp } from "../../src/operations/stop.ts";
import {
  acceleratedPlan,
  app,
  recoveryHarness,
  session,
  target,
} from "./accelerated-start-recovery-support.ts";

test("start reseeds retained targets before creating planned sessions", async () => {
  // Given a retained attempt with an old two-way session.
  const harness = await Effect.runPromise(recoveryHarness());
  // When start retries the same plan.
  const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
  // Then old data never flows to the host, and the successful attempt unblocks other operations.
  if (Exit.isFailure(result)) throw Option.getOrThrow(Cause.failureOption(result.cause));
  expect(harness.calls).toEqual([
    "terminate:old",
    "prepare",
    "create:one-way-replica",
    "flush:one-way-replica",
    "terminate:one-way-replica",
    "create:two-way-safe",
    "flush:two-way-safe",
  ]);
  await Effect.runPromise(requireNoPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer)));
});

test("start refuses a changed mount plan without mutation", async () => {
  // Given a retained attempt and changed excludes.
  const harness = await Effect.runPromise(recoveryHarness());
  const plan = {
    ...acceleratedPlan,
    fileSync: [{ engineId: "mutagen", session: { ...session, excludes: ["changed"] } }],
  };
  // When start uses the changed plan.
  const result = await Effect.runPromiseExit(
    startApp({}, { ...target, plan }).pipe(Effect.provide(harness.layer)),
  );
  // Then recovery explains the mismatch and preserves everything.
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result))
    expect(Option.getOrThrow(Cause.failureOption(result.cause)).message).toContain(
      "mount plan digest changed",
    );
  expect(harness.calls).toEqual([]);
});

test.each([{ extraSession: true }, { replica: false }, { failFlush: true }, { changedVolume: true }])(
  "failed recovery retains its journal with the recovery error first: %j",
  async (options) => {
    // Given an unsafe or failing recovery.
    const harness = await Effect.runPromise(recoveryHarness(options));
    // When start attempts recovery.
    const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
    // Then the retained-journal error leads the cause and no planned-mode session is created.
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Option.getOrThrow(Cause.failureOption(result.cause)).message).toContain(
        "cannot roll back prepared accelerated sync targets",
      );
    expect(harness.calls).not.toContain("create:two-way-safe");
    if ("extraSession" in options) expect(harness.calls).toEqual([]);
    const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(pending?.phase).toBe("retained");
  },
);

test.each(["stop", "restart", "rebuild"] as const)("%s still blocks retained attempts", async (operation) => {
  // Given a retained attempt.
  const harness = await Effect.runPromise(recoveryHarness());
  const operations = {
    stop: stopApp({}, target).pipe(Effect.asVoid),
    restart: restartApp({}, target).pipe(Effect.asVoid),
    rebuild: rebuildApp({}, target).pipe(Effect.asVoid),
  };
  // When a non-start lifecycle operation is requested.
  const result = await Effect.runPromiseExit(operations[operation].pipe(Effect.provide(harness.layer)));
  // Then nothing mutates.
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).toEqual([]);
});

test.each([
  { plan: { ...acceleratedPlan, provider: ProviderId.make("other") }, reason: "provider changed" },
  { plan: { ...acceleratedPlan, fileSync: [{ engineId: "other", session }] }, reason: "engine changed" },
  { plan: { ...acceleratedPlan, fileSync: [] }, reason: "mount plan digest changed" },
])("start blocks mismatched retained identities: $reason", async ({ plan, reason }) => {
  // Given a retained attempt with different desired identity.
  const harness = await Effect.runPromise(recoveryHarness());
  // When start attempts the changed plan.
  const result = await Effect.runPromiseExit(
    startApp({}, { ...target, plan }).pipe(Effect.provide(harness.layer)),
  );
  // Then it explains why recovery is impossible without mutating resources.
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result))
    expect(Option.getOrThrow(Cause.failureOption(result.cause)).message).toContain(reason);
  expect(harness.calls).toEqual([]);
});

test("recovery compares the built plan rather than the initial plan", async () => {
  // Given an initial plan that the build orchestrator resolves to the retained plan.
  const harness = await Effect.runPromise(recoveryHarness());
  const plan = {
    ...acceleratedPlan,
    fileSync: [{ engineId: "mutagen", session: { ...session, excludes: ["before-build"] } }],
  };
  // When the build returns the original mount plan.
  await Effect.runPromise(
    startApp({}, { ...target, plan }).pipe(
      Effect.provideService(BuildOrchestrator, {
        build: () => Effect.succeed(acceleratedPlan),
        buildApp: () => Effect.void,
      }),
      Effect.provide(harness.layer),
    ),
  );
  // Then recovery reseeds and completes normally.
  expect(harness.calls).toContain("create:one-way-replica");
  expect(harness.calls).toContain("create:two-way-safe");
});

test("adoption replaces the durable attempt before target mutation", async () => {
  // Given a retained version-1 attempt.
  const harness = await Effect.runPromise(recoveryHarness());
  const before = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  // When the journal is adopted without doing any provider work.
  const adopted = await Effect.runPromise(
    beginAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer)),
  );
  // Then a new preparing attempt is durable, while recorded identities remain available for recovery.
  const after = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(after.pending?.phase).toBe("preparing");
  expect(after.pending?.attemptId).toBe(adopted.attemptId);
  expect(adopted.attemptId).not.toBe(before.pending?.attemptId);
  expect(adopted.retained ?? null).toEqual(before.pending);
  expect(harness.calls).toEqual([]);
});
