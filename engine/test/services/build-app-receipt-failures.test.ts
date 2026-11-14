import { expect, test } from "bun:test";
import { FailureRoleAnnotation, failureOutcomeFromCause } from "@lando/sdk/command-result";
import { ProviderInternalError, SecretStoreUnavailableError, StateStoreError } from "@lando/sdk/errors";
import type { ProviderError } from "@lando/sdk/services";
import { Cause, Context, Effect, Exit, Stream } from "effect";
import { providerId, withTempRoots } from "./build-app-runner-test-support.ts";
import {
  captureBuild,
  captureStepSettlement,
  retainedProvider,
  settlementStore,
  storageFailure,
  taskDispositions,
} from "./build-app-settlement-support.ts";

const persistenceDefect = { operation: "receipt-fsync", detail: "descriptor closed" };
const persistenceInterrupt = Effect.failCause(Cause.interrupt(731));
for (const receipt of [
  {
    name: "defect",
    effect: Effect.die(persistenceDefect),
    typed: false,
    defects: [persistenceDefect],
    interrupts: [],
  },
  { name: "interrupt", effect: persistenceInterrupt, typed: false, defects: [], interrupts: [731] },
  {
    name: "typed failure and cleanup defect",
    effect: Effect.fail(storageFailure).pipe(Effect.ensuring(Effect.die(persistenceDefect))),
    typed: true,
    defects: [persistenceDefect],
    interrupts: [],
  },
  {
    name: "typed failure and cleanup interrupt",
    effect: Effect.fail(storageFailure).pipe(Effect.ensuring(persistenceInterrupt)),
    typed: true,
    defects: [],
    interrupts: [731],
  },
] as const) {
  test(`exit 7 stays primary when its failure receipt has ${receipt.name}`, async () => {
    await withTempRoots(async () => {
      const result = await Effect.runPromise(
        captureStepSettlement(
          { ...retainedProvider, execStream: () => Stream.make({ exitCode: 7 }) },
          settlementStore({ update: () => receipt.effect }),
        ),
      );
      if (Exit.isSuccess(result.exit)) throw new TypeError("command failure recovered");
      const primary = {
        _tag: "BuildPhaseFailedError",
        failures: [{ step: { id: "web:app:install" }, exitCode: 7 }],
      };
      expect(failureOutcomeFromCause(result.exit.cause).error).toMatchObject(primary);
      expect(
        result.exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
      ).toMatchObject([
        primary,
        ...(receipt.typed
          ? [{ _tag: "ProviderInternalError", operation: "buildResults", cause: storageFailure }]
          : []),
      ]);
      expect(result.exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual([
        ...receipt.defects,
      ]);
      expect(
        result.exit.cause.reasons.filter(Cause.isInterruptReason).map((reason) => reason.fiberId),
      ).toEqual([...receipt.interrupts]);
      const cleanup = result.exit.cause.reasons.filter((reason) => !Cause.isInterruptReason(reason)).slice(1);
      expect(
        cleanup.map((reason) =>
          Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation),
        ),
      ).toEqual(cleanup.map(() => "cleanup"));
      expect(result.warnings).toEqual([]);
      expect(result.entries).toEqual([]);
      taskDispositions(result.events, { "web:app:install": "task.fail" });
      expect(result.events.find((event) => event._tag === "task.fail")).toMatchObject({ exitCode: 7 });
      expect(result.events.find((event) => event._tag === "task.tree.complete")).toMatchObject({
        outcome: "failure",
        failed: 1,
      });
    });
  });
}

const secretFailure = new SecretStoreUnavailableError({
  storeId: "locked",
  reason: "locked",
  message: "Secret store is locked",
  remediation: "Unlock it.",
});
const providerFailure = new ProviderInternalError({
  providerId,
  operation: "execStream",
  message: "Provider failed",
  remediation: "Repair the provider.",
});
const bodyDefect = { operation: "exec-cleanup", detail: "provider cleanup failed" };
for (const body of [
  {
    name: "secret failure",
    effect: Effect.fail(secretFailure),
    failures: [secretFailure],
    defects: [],
    interrupts: [],
    summary: secretFailure.message,
  },
  {
    name: "mixed provider failure",
    effect: Effect.fail(providerFailure).pipe(Effect.ensuring(Effect.die(bodyDefect))),
    failures: [providerFailure],
    defects: [bodyDefect],
    interrupts: [],
    summary: providerFailure.message,
  },
  {
    name: "interruption",
    effect: Effect.failCause(Cause.interrupt(517)),
    failures: [],
    defects: [],
    interrupts: [517],
    summary: "web:app:install interrupted",
  },
] as const) {
  test(`receipt defect preserves the already failing ${body.name} exactly once`, async () => {
    await withTempRoots(async () => {
      const result = await Effect.runPromise(
        captureStepSettlement(
          {
            ...retainedProvider,
            execStream: () => Stream.fromEffect<never, ProviderError, never>(body.effect),
          },
          settlementStore({ update: () => Effect.die(persistenceDefect) }),
        ),
      );
      if (Exit.isSuccess(result.exit)) throw new TypeError("body failure recovered");
      expect(result.exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([
        ...body.failures,
      ]);
      expect(result.exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual([
        ...body.defects,
        persistenceDefect,
      ]);
      expect(
        result.exit.cause.reasons.filter(Cause.isInterruptReason).map((reason) => reason.fiberId),
      ).toEqual([...body.interrupts]);
      if (body.failures.length > 0)
        expect(failureOutcomeFromCause(result.exit.cause).error).toEqual(body.failures[0]);
      const receiptReason = result.exit.cause.reasons.find(
        (reason) => Cause.isDieReason(reason) && reason.defect === persistenceDefect,
      );
      expect(
        receiptReason === undefined
          ? undefined
          : Context.getOrUndefined(Cause.reasonAnnotations(receiptReason), FailureRoleAnnotation),
      ).toBe("cleanup");
      expect(result.warnings).toEqual([]);
      taskDispositions(result.events, { "web:app:install": "task.fail" });
      expect(result.events.find((event) => event._tag === "task.fail")).toMatchObject({
        summary: body.summary,
      });
      expect(
        result.events.find((event) => event._tag === "task.fail" && event.exitCode !== undefined),
      ).toBeUndefined();
    });
  });
}

test("the app scheduler preserves command failure and receipt cleanup diagnostics", async () => {
  await withTempRoots(async () => {
    const result = await Effect.runPromise(
      captureBuild(
        { ...retainedProvider, execStream: () => Stream.make({ exitCode: 7 }) },
        settlementStore({
          update: () => Effect.fail(storageFailure).pipe(Effect.ensuring(Effect.die(persistenceDefect))),
        }),
      ),
    );
    if (Exit.isSuccess(result.exit)) throw new TypeError("phase failure recovered");
    expect(failureOutcomeFromCause(result.exit.cause)).toMatchObject({
      error: { _tag: "BuildPhaseFailedError", failures: [{ exitCode: 7 }] },
      additionalErrors: [
        { role: "cleanup", error: { _tag: "ProviderInternalError", cause: storageFailure } },
        { role: "cleanup", error: persistenceDefect },
      ],
    });
    taskDispositions(result.events, { "web:app:install": "task.fail" });
    expect(result.events.find((event) => event._tag === "task.fail")).toMatchObject({ exitCode: 7 });
  });
});

test("multiple typed-only receipt failures warn without replacing the command failure", async () => {
  await withTempRoots(async () => {
    const cleanupFailure = new StateStoreError({
      reason: "lock",
      operation: "unlock-receipt",
      cause: "unlock-receipt",
      remediation: "Restore the receipt lock.",
    });
    const result = await Effect.runPromise(
      captureBuild(
        { ...retainedProvider, execStream: () => Stream.make({ exitCode: 7 }) },
        settlementStore({
          update: () => Effect.fail(storageFailure).pipe(Effect.onExit(() => Effect.fail(cleanupFailure))),
        }),
      ),
    );
    if (Exit.isSuccess(result.exit)) throw new TypeError("command failure recovered");
    expect(failureOutcomeFromCause(result.exit.cause)).toMatchObject({
      error: { _tag: "BuildPhaseFailedError", failures: [{ exitCode: 7 }] },
      additionalErrors: [],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("LANDO_BUILD_RESULT_NOT_RECORDED");
    expect(JSON.stringify(result.warnings)).toContain("unlock-receipt");
    expect(JSON.stringify(result.warnings)).toContain("persistence-secret");
  });
});
