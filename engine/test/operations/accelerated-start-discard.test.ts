import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { destroyApp } from "../../src/operations/destroy.ts";
import { recoveryHarness, target } from "./accelerated-start-recovery-support.ts";

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

test.each([{ phase: "preparing" as const }, { extraSession: true }])(
  "retained destroy fails closed for %j",
  async (options) => {
    const harness = await Effect.runPromise(recoveryHarness(options));
    const result = await Effect.runPromiseExit(destroyApp({}, target).pipe(Effect.provide(harness.layer)));
    expect(Exit.isFailure(result)).toBe(true);
    expect(harness.calls).not.toContain("dispose");
    expect(harness.calls).not.toContain("dispose-targets");
  },
);
