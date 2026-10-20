import { expect, test } from "bun:test";
import { AbsolutePath, FileSyncSessionRef, ProviderId } from "@lando/sdk/schema";
import { Cause, Effect, Exit } from "effect";
import {
  beginOrResumeAcceleratedStart,
  openJournal,
  readJournal,
} from "../../src/operations/accelerated-start-journal.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { startApp } from "../../src/operations/start.ts";
import { acceleratedPlan, app, recoveryHarness, target } from "./accelerated-start-recovery-support.ts";

const phases = ["preparing", "sessions-ready", "apply-intent"] as const;

test.each([...phases, "retained"] as const)(
  "version-1 %s journal migrates without losing attempt identity",
  async (phase) => {
    const harness = await Effect.runPromise(recoveryHarness({ phase: "preparing" }));
    const bucket = await Effect.runPromise(openJournal(app).pipe(Effect.provide(harness.layer)));
    const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    await Effect.runPromise(
      harness.stateStore.writeRaw(
        AbsolutePath.make(bucket.path),
        JSON.stringify({ version: 1, data: { ...pending, phase, recoveredFrom: "old-origin" } }),
      ),
    );
    const migrated = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(migrated.pending).toMatchObject({
      attemptId: pending?.attemptId,
      phase: phase === "retained" ? "apply-intent" : phase,
    });
    expect(migrated.pending).not.toHaveProperty("recoveredFrom");
  },
);

test.each(
  phases.flatMap((phase) =>
    (["one-way-replica", "two-way-safe"] as const).flatMap((mode) =>
      ["start", "destroy"].map((operation) => ({ phase, mode, operation })),
    ),
  ),
)("interrupted attempt preserves exact history or fails closed: %j", async ({ phase, mode, operation }) => {
  const harness = await Effect.runPromise(recoveryHarness({ phase }));
  const previous = harness.sessions[0];
  if (previous === undefined) throw new TypeError("Expected session");
  harness.sessions.splice(0, 1, {
    ...previous,
    ref: FileSyncSessionRef.make("interrupted"),
    spec: { ...previous.spec, mode },
  });
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      if (operation === "start") yield* startApp({}, target);
      else yield* destroyApp({}, target);
    }).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isSuccess(result)).toBe(mode === "two-way-safe");
  expect(harness.calls).not.toContain("terminate:interrupted");
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  if (mode === "one-way-replica") {
    expect(harness.sessions).toHaveLength(1);
    expect(harness.calls).not.toContain("flush:interrupted");
    expect(pending?.phase).toBe(phase);
  } else {
    expect(pending?.phase).toBe("completed");
    expect(harness.calls).not.toContain("create:one-way-replica");
    if (operation === "start") expect(harness.calls).toContain("flush:interrupted");
    else expect(harness.calls).toContain("dispose-targets");
  }
});

test("completion permits a fresh attempt with no recovery lineage", async () => {
  const harness = await Effect.runPromise(recoveryHarness());
  const first = await Effect.runPromise(
    beginOrResumeAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer)),
  );
  await Effect.runPromise(first.complete);
  const second = await Effect.runPromise(
    beginOrResumeAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer)),
  );
  expect(second.attemptId).not.toBe(first.attemptId);
  expect(second.resumedFrom).toBeUndefined();
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending).not.toHaveProperty("recoveredFrom");
});

test.each(["provider", "engine", "digest"] as const)(
  "interrupted attempt still checks %s before mutation",
  async (changed) => {
    const harness = await Effect.runPromise(recoveryHarness({ phase: "preparing" }));
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
    const before = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    const result = await Effect.runPromiseExit(
      beginOrResumeAcceleratedStart(plans[changed], app).pipe(Effect.provide(harness.layer)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Cause.findErrorOption(result.cause)).toMatchObject({ value: { _tag: "FileSyncStartError" } });
    const after = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(after.pending).toEqual(before.pending);
    expect(harness.calls).toEqual([]);
  },
);
