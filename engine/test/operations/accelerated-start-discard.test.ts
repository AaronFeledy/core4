import { expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { readJournal } from "../../src/operations/accelerated-start-journal.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { acceleratedPlan, app, recoveryHarness, target } from "./accelerated-start-recovery-support.ts";

test.each([false, true])(
  "explicit-target orphan destroy checks pending journal identity mismatch=%s",
  async (mismatch) => {
    // Given orphan evidence for a Landofile-bearing target with an unfinished attempt.
    const harness = await Effect.runPromise(
      recoveryHarness({
        phase: "apply-intent",
        appliedState: "unknown",
        harnessOptions: {
          resolveTeardownEvidence: () =>
            Effect.succeed({
              kind: "orphans",
              groups: [{ providerId: acceleratedPlan.provider, appId: app.id, services: [], volumes: [] }],
            }),
        },
      }),
    );
    const desired = {
      ...target,
      landofile: { name: "test-start", services: {} },
      plan: mismatch ? { ...acceleratedPlan, fileSync: [] } : acceleratedPlan,
    };
    // When destroy receives the explicit desired target.
    const result = await Effect.runPromiseExit(destroyApp({}, desired).pipe(Effect.provide(harness.layer)));
    // Then disposal precedes provider destruction, or identity failure leaves everything untouched.
    if (mismatch) {
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.findErrorOption(result.cause)).toMatchObject({ value: { _tag: "FileSyncStopError" } });
      expect(harness.calls).toEqual([]);
    } else {
      expect(Exit.isSuccess(result)).toBe(true);
      expect(harness.calls).toEqual([
        "quiesce-retained",
        "drain",
        "dispose",
        "dispose-targets",
        "complete",
        "destroy:false",
      ]);
      const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
      expect(pending?.phase).toBe("completed");
    }
  },
);

test("retained destroy fails closed without provider writer and target cleanup hooks", async () => {
  const harness = await Effect.runPromise(
    recoveryHarness({
      appliedState: "unknown",
      cleanupHooks: false,
    }),
  );
  const result = await Effect.runPromiseExit(destroyApp({}, target).pipe(Effect.provide(harness.layer)));
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).toEqual([]);
  expect(harness.sessions.map(({ ref }) => String(ref))).toEqual(["old"]);
});

test.each([{ extraSession: true }, { phase: "preparing" as const, extraSession: true }])(
  "retained destroy fails closed for %j",
  async (options) => {
    const harness = await Effect.runPromise(recoveryHarness(options));
    const result = await Effect.runPromiseExit(destroyApp({}, target).pipe(Effect.provide(harness.layer)));
    expect(Exit.isFailure(result)).toBe(true);
    expect(harness.calls).not.toContain("dispose");
    expect(harness.calls).not.toContain("dispose-targets");
  },
);
