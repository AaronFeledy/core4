import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { readJournal } from "../../src/operations/accelerated-start-journal.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { app, recoveryHarness, target } from "./accelerated-start-recovery-support.ts";

test.each([false, true])("destroy discards recorded sessions and honors volumes=%s", async (volumes) => {
  // Given a retained attempt.
  const harness = await Effect.runPromise(recoveryHarness({ appliedState: "unknown" }));
  // When destroy is requested.
  await Effect.runPromise(destroyApp({ volumes }, target).pipe(Effect.provide(harness.layer)));
  // Then sessions terminate without a flush, provider cleanup precedes completion.
  expect(harness.calls).toEqual(["terminate:old", `destroy:${volumes}`]);
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending?.phase).toBe("completed");
});

test.each([{ phase: "preparing" as const }, { extraSession: true }])(
  "destroy fails closed for %j",
  async (options) => {
    // Given an unresolved active attempt or an unknown session.
    const harness = await Effect.runPromise(recoveryHarness(options));
    // When destroy is requested.
    const result = await Effect.runPromiseExit(destroyApp({}, target).pipe(Effect.provide(harness.layer)));
    // Then neither recorded sessions nor provider resources are touched.
    expect(Exit.isFailure(result)).toBe(true);
    expect(harness.calls).toEqual([]);
  },
);
