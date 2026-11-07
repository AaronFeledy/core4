import { expect, test } from "bun:test";
import { ProviderInternalError } from "@lando/sdk/errors";
import type { FileSyncDisposalStep } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Exit } from "effect";
import { prepareDestroyFileSync } from "../../src/operations/destroy-file-sync.ts";
import { recoveryHarness, target } from "./accelerated-start-recovery-support.ts";
import { disposalPhaseTracker } from "./file-sync-disposal-support.ts";

test.each([
  { phase: "absent", resumed: false, calls: ["targets"], failTargets: false },
  {
    phase: "active",
    resumed: false,
    calls: ["drain", "dispose", "targets", "completeDisposal"],
    failTargets: false,
  },
  {
    phase: "drained",
    resumed: false,
    calls: ["drain", "dispose", "targets", "completeDisposal"],
    failTargets: false,
  },
  {
    phase: "disposing",
    resumed: true,
    calls: ["dispose", "targets", "completeDisposal"],
    failTargets: false,
  },
  { phase: "completed", resumed: true, calls: [], failTargets: false },
  { phase: "drained", resumed: false, calls: ["drain", "dispose", "targets"], failTargets: true },
] as const)("destroy from $phase preserves cleanup ordering (target failure: $failTargets)", async (row) => {
  const disposal = disposalPhaseTracker(row.phase);
  const calls: string[] = [];
  const apply = (operation: FileSyncDisposalStep) =>
    Effect.gen(function* () {
      yield* disposal.apply(operation);
      calls.push(operation);
    });
  const harness = await Effect.runPromise(
    recoveryHarness({
      phase: "preparing",
      engineOverrides: {
        appLifecycle: {
          disposalPhase: () => Effect.sync(disposal.phase),
          invalidateDrain: () => disposal.apply("invalidateDrain"),
          drain: () => apply("drain"),
          dispose: () => apply("dispose"),
          completeDisposal: () => apply("completeDisposal"),
        },
      },
      harnessOptions: {
        disposeFileSyncTargets: () =>
          Effect.suspend(() => {
            calls.push("targets");
            return row.failTargets
              ? Effect.fail(
                  new ProviderInternalError({
                    providerId: "test",
                    operation: "disposeFileSyncTargets",
                    message: "Target cleanup failed",
                    remediation: "Retry target cleanup.",
                  }),
                )
              : Effect.void;
          }),
      },
    }),
  );
  if (row.phase === "absent") harness.sessions.splice(0);
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const provider = yield* (yield* RuntimeProviderRegistry).select(target.plan);
      const prepared = yield* prepareDestroyFileSync(target, provider);
      expect(prepared.resumed).toBe(row.resumed);
      yield* prepared.dispose;
    }).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isFailure(result)).toBe(row.failTargets);
  expect(calls).toEqual([...row.calls]);
  expect(disposal.phase()).toBe(
    row.failTargets ? "disposing" : row.phase === "absent" ? "absent" : "completed",
  );
});
