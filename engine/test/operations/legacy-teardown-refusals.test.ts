import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ManagedFileTransactionError } from "@lando/sdk/errors";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect } from "effect";
import { openJournal } from "../../src/operations/accelerated-start-journal.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { current, fixture, stale, target } from "./legacy-teardown-support.ts";

test.each(["stop", "destroy"] as const)(
  "%s refuses a blocked transaction before retiring either name",
  async (command) => {
    const harness = fixture();
    const failure = new ManagedFileTransactionError({
      reason: "blocked",
      phase: "recover",
      path: current.root,
      cause: "invariant",
      remediation: "Resolve the managed-file conflict.",
    });
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          if (command === "stop") yield* stopApp({}, target);
          else yield* destroyApp({}, target);
        }).pipe(
          Effect.provideService(ManagedFileTransactionGuard, {
            assertReadable: () => Effect.void,
            pending: () => Effect.succeed(null),
            ensureConsistent: () => Effect.fail(failure),
          }),
          Effect.provide(harness.layer),
          Effect.result,
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ManagedFileTransactionError", reason: "blocked" },
      });
      expect(harness.applied.map((plan) => plan.id)).toEqual([stale.id, current.id]);
      expect([...harness.containers]).toEqual([stale.id, current.id]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test.each(["stop", "destroy"] as const)(
  "%s refuses an unfinished journal before retiring either name",
  async (command) => {
    const harness = fixture();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bucket = yield* openJournal(target.app);
          yield* bucket.update(() => ({
            attemptId: "interrupted",
            appId: stale.id,
            appRoot: stale.root,
            providerId: stale.provider,
            engineId: "mutagen",
            mountPlanDigest: "old",
            phase: "preparing",
            targets: [],
            sessions: [],
          }));
        }).pipe(Effect.provide(harness.layer)),
      );
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          if (command === "stop") yield* stopApp({}, target);
          else yield* destroyApp({}, target);
        }).pipe(Effect.provide(harness.layer), Effect.result),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "FileSyncStopError" } });
      expect(harness.applied.map((plan) => plan.id)).toEqual([stale.id, current.id]);
      expect([...harness.containers]).toEqual([stale.id, current.id]);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
