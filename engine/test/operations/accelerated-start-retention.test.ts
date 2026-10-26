import { expect, test } from "bun:test";
import { FileSyncStopError, ProviderUnavailableError } from "@lando/sdk/errors";
import { FileSyncEngine } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { readJournal } from "../../src/operations/accelerated-start-journal.ts";
import { startApp } from "../../src/operations/start.ts";
import { app, recoveryHarness, target } from "./accelerated-start-recovery-support.ts";

test.each(["preparing", "sessions-ready", "apply-intent"] as const)(
  "resume from %s preserves only the original failure without draining sessions",
  async (phase) => {
    const original = new ProviderUnavailableError({
      providerId: "lando",
      operation: "apply",
      message: "apply failed",
      remediation: "Install or start the `lando` provider and confirm it can perform `apply`.",
    });
    const secondary = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: "old",
      message: "drain failed",
      remediation:
        "Fix the reported file-sync session failure, then retry `lando stop` or terminate the named session in the engine.",
    });
    const harness = await Effect.runPromise(
      recoveryHarness({ phase, harnessOptions: { applyEffect: Effect.fail(original) } }),
    );
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const engine = yield* FileSyncEngine;
        if (engine.appLifecycle === undefined)
          return yield* Effect.die(new TypeError("Expected durable engine"));
        const { bindPreparedTargets: _, ...unboundEngine } = engine;
        return yield* startApp({}, target).pipe(
          Effect.provideService(FileSyncEngine, {
            ...unboundEngine,
            appLifecycle: { ...engine.appLifecycle, drain: () => Effect.fail(secondary) },
          }),
        );
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const failures = result.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
      expect(failures).toEqual([original]);
    }
    const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(pending?.phase).toBe("apply-intent");
    expect(harness.calls).not.toContain("terminate:old");
    expect(harness.calls).not.toContain("drain");
  },
);
