import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import {
  beginOrResumeAcceleratedStart,
  readPendingAcceleratedStart,
} from "../../src/operations/accelerated-start-journal.ts";
import { startApp } from "../../src/operations/start.ts";
import { acceleratedPlan, app, recoveryHarness, target } from "./accelerated-start-recovery-support.ts";

type HarnessLayer = Effect.Success<ReturnType<typeof recoveryHarness>>["layer"];

const runStart = async (layer: HarnessLayer) => {
  const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(layer)));
  if (Exit.isFailure(result)) throw Option.getOrThrow(Cause.findErrorOption(result.cause));
};

test("a second ordinary start reuses the healthy session the first start created", async () => {
  const harness = await Effect.runPromise(recoveryHarness({ replica: false }));
  // Begin from a finished attempt with no session, so both starts take the ordinary path.
  await Effect.runPromise(
    beginOrResumeAcceleratedStart(acceleratedPlan, app).pipe(
      Effect.flatMap((pending) => pending.complete),
      Effect.provide(harness.layer),
    ),
  );
  harness.sessions.splice(0);

  await runStart(harness.layer);
  const created = harness.sessions.map(({ ref }) => String(ref));
  expect(created).toHaveLength(1);
  expect(harness.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);

  harness.calls.splice(0);
  await runStart(harness.layer);

  expect(harness.calls.some((call) => call.startsWith("create:"))).toBe(false);
  expect(harness.calls.some((call) => call.startsWith("terminate:"))).toBe(false);
  expect(harness.calls).toContain(`flush:${created[0]}`);
  expect(harness.sessions.map(({ ref }) => String(ref))).toEqual(created);
  expect(
    await Effect.runPromise(readPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer))),
  ).toBeNull();
});
