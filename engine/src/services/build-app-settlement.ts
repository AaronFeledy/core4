import {
  TaskCompleteEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { BuildAppError } from "@lando/sdk/services";
import { Cause, DateTime, Effect, Exit } from "effect";
import {
  type AppStepDisposition,
  type AppStepOutcome,
  type AppStepStart,
  type AppStepStarted,
  appStepDisposition,
  failedAppStepDisposition,
} from "./build-app-disposition.ts";
import { isScratchPlan } from "./build-app-kind.ts";
import type { AppStep } from "./build-app-plan.ts";
import { makeAppBuildReceipts } from "./build-app-receipts.ts";
import type { AppBuildInput } from "./build-app-step-runner.ts";

type TaskState =
  | { readonly _tag: "pending" }
  | { readonly _tag: "started"; readonly evidence: AppStepStarted }
  | { readonly _tag: "settled"; readonly disposition: AppStepDisposition; readonly dispatched: boolean };

export const makeAppBuildSettlement = (input: AppBuildInput, steps: readonly AppStep[]) => {
  const parentId = `build-app-${String(input.plan.id)}`;
  const began = performance.now();
  const ledger = new Map<string, TaskState>(steps.map(({ step }) => [step.id, { _tag: "pending" }]));
  const receipts = makeAppBuildReceipts(input);
  const start = (appStep: AppStep, evidence: AppStepStarted) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (ledger.get(appStep.step.id)?._tag !== "pending") return;
        yield* input.events.publish(
          TaskStartEvent.make({
            taskId: appStep.step.id,
            parentId,
            label: `Build ${String(appStep.step.service)}`,
            ...(evidence.transcriptPath === undefined ? {} : { transcriptPath: evidence.transcriptPath }),
            timestamp: yield* DateTime.now,
          }),
        );
        ledger.set(appStep.step.id, { _tag: "started", evidence });
      }),
    );
  const terminal = Effect.fnUntraced(function* (appStep: AppStep, disposition: AppStepDisposition) {
    const state = ledger.get(appStep.step.id);
    if (state?._tag === "settled") return;
    yield* start(appStep, {});
    const common = {
      taskId: appStep.step.id,
      summary: input.redaction.redactor.redactString(disposition.summary),
      durationMs: disposition.durationMs,
      timestamp: yield* DateTime.now,
    };
    yield* input.events.publish(
      disposition.outcome === "succeeded"
        ? TaskCompleteEvent.make(common)
        : TaskFailEvent.make({
            ...common,
            ...(disposition.failure?.exitCode === undefined
              ? {}
              : { exitCode: disposition.failure.exitCode }),
          }),
    );
    ledger.set(appStep.step.id, {
      _tag: "settled",
      disposition,
      dispatched: state?._tag === "started" && state.evidence.attempt !== undefined,
    });
  });
  const failedDisposition = (appStep: AppStep, cause: Cause.Cause<BuildAppError>) =>
    failedAppStepDisposition(appStep, cause, performance.now() - began);
  const skip = Effect.fnUntraced(function* (appStep: AppStep, cached: boolean) {
    yield* input.events.publish({
      _tag: "build-step-skip",
      eventName: "build-step-skip",
      appRef: {
        kind: isScratchPlan(input.plan) ? "scratch" : "user",
        id: input.redaction.redactor.redactString(input.plan.slug),
      },
      serviceName: input.redaction.redactor.redactString(appStep.step.service),
      providerId: input.redaction.redactor.redactString(input.plan.provider),
      phase: "app",
      buildKey: appStep.step.buildKey,
      cached,
      reason: cached ? "up-to-date" : "phase-aborted",
      timestamp: yield* DateTime.now,
    });
  });
  const settle = Effect.fnUntraced(function* (
    appStep: AppStep,
    exit: Exit.Exit<AppStepOutcome, BuildAppError>,
  ) {
    if (Exit.isFailure(exit)) {
      const state = ledger.get(appStep.step.id);
      const disposition = failedDisposition(appStep, exit.cause);
      if (state?._tag === "started" && state.evidence.attempt !== undefined)
        return yield* receipts
          .record(appStep, state.evidence.attempt, { outcome: "fail", durationMs: disposition.durationMs })
          .pipe(Effect.onExit(() => terminal(appStep, disposition)));
      yield* terminal(appStep, disposition);
      return;
    }
    const disposition = appStepDisposition(input, appStep, exit.value);
    yield* start(appStep, {});
    switch (exit.value._tag) {
      case "blocked":
        yield* skip(appStep, false);
        break;
      case "reused":
        yield* receipts.markUsed(exit.value.entry);
        yield* skip(appStep, true);
        break;
      case "ran":
        if (disposition.outcome === "succeeded") {
          yield* receipts.record(appStep, exit.value.attempt, {
            durationMs: disposition.durationMs,
            outcome: "complete",
            ...(exit.value.result.exitCode === undefined ? {} : { exitCode: exit.value.result.exitCode }),
          });
        } else
          return yield* receipts
            .record(appStep, exit.value.attempt, {
              outcome: "fail",
              durationMs: disposition.durationMs,
              ...(disposition.failure === undefined ? {} : { failure: disposition.failure }),
            })
            .pipe(Effect.onExit(() => terminal(appStep, disposition)));
        break;
      default:
        return exit.value satisfies never;
    }
    yield* terminal(appStep, disposition);
  });
  const run = (
    appStep: AppStep,
    work: (start: AppStepStart) => Effect.Effect<AppStepOutcome, BuildAppError>,
  ) =>
    Effect.suspend(() => work((evidence) => start(appStep, evidence))).pipe(
      Effect.onExit((exit) =>
        settle(appStep, exit).pipe(
          Effect.onExit((settled) =>
            Exit.isFailure(settled)
              ? terminal(appStep, failedDisposition(appStep, settled.cause))
              : Effect.void,
          ),
        ),
      ),
      Effect.map((outcome) => appStepDisposition(input, appStep, outcome).outcome),
    );
  const finalize = Effect.fnUntraced(function* (exit: Exit.Exit<void, BuildAppError>) {
    if (Exit.isFailure(exit))
      for (const appStep of steps) yield* terminal(appStep, failedDisposition(appStep, exit.cause));
    const succeeded = [...ledger.values()].filter(
      (state) => state._tag === "settled" && state.disposition.outcome === "succeeded",
    ).length;
    const outcome = Exit.isSuccess(exit)
      ? undefined
      : Cause.hasInterruptsOnly(exit.cause)
        ? "interrupted"
        : "failure";
    yield* input.events.publish(
      TaskTreeCompleteEvent.make({
        parentId,
        summary:
          outcome === undefined
            ? "App dependencies built"
            : `App dependency build ${outcome === "failure" ? "failed" : "interrupted"}`,
        succeeded,
        failed: steps.length - succeeded,
        ...(outcome === undefined ? {} : { outcome }),
        durationMs: performance.now() - began,
        timestamp: yield* DateTime.now,
      }),
    );
  });
  return {
    run,
    finalize,
    startTree: Effect.gen(function* () {
      yield* input.events.publish(
        TaskTreeStartEvent.make({
          parentId,
          label: "Building app dependencies",
          children: steps.map(({ step }) => step.id),
          mode: "list",
          timestamp: yield* DateTime.now,
        }),
      );
    }),
    load: receipts.load,
    failures: () =>
      steps.flatMap(({ step }) => {
        const state = ledger.get(step.id);
        return state?._tag === "settled" && state.disposition.failure !== undefined
          ? [state.disposition.failure]
          : [];
      }),
    dispatched: () => [...ledger.values()].some((state) => state._tag === "settled" && state.dispatched),
  };
};
