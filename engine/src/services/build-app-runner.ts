import { availableParallelism } from "node:os";
import { gateId } from "@lando/container-runtime/dependency-gates";
import { runDependencySchedule } from "@lando/container-runtime/dependency-schedule";
import { listenerAuthorityAction, listenerDiagnostic } from "@lando/container-runtime/listener-diagnostic";
import { dependencyGateRemediation } from "@lando/container-runtime/podman/bring-up";
import { mapFailures } from "@lando/sdk/command-result";
import { BuildPhaseFailedError, type BuildStepFailedError, ProviderInternalError } from "@lando/sdk/errors";
import { TaskFailEvent, TaskStartEvent, TaskTreeCompleteEvent, TaskTreeStartEvent } from "@lando/sdk/events";
import type { BuildAppOptions } from "@lando/sdk/services";
import { Cause, DateTime, Effect, Exit } from "effect";

import { validateHealthcheckExecution } from "../subsystems/healthcheck/attempt.ts";
import { type AppBuildGateResult, runAppBuildGate } from "./build-app-gates.ts";
import { buildAppGraph } from "./build-app-graph.ts";
import { isScratchPlan } from "./build-app-kind.ts";
import { appSteps } from "./build-app-plan.ts";
import {
  type AppStepExecution,
  buildResultsError,
  makeAppStepExecution,
} from "./build-app-step-execution.ts";
import type { AppBuildInput } from "./build-app-step-runner.ts";
import { BuildOwner } from "./build-owner.ts";
import { openAppBuildResults } from "./build-results.ts";
import { sweepAppBuildTranscripts } from "./build-transcript-cleanup.ts";

const timestamp = DateTime.now;

const planError = (input: AppBuildInput, edges: ReadonlyArray<string>) =>
  new ProviderInternalError({
    providerId: input.provider.id,
    operation: "buildAppPlan",
    message: "App build steps contain a dependency cycle.",
    details: { edges },
    remediation: "Remove the cyclic app build-step dependencies and retry.",
  });

export const runAppBuild = Effect.fn("BuildOrchestrator.runAppBuild")(function* (
  input: AppBuildInput,
  options: BuildAppOptions = {},
) {
  yield* validateHealthcheckExecution(input.plan, input.hostProbeRunners ?? {});
  const steps = appSteps(input.plan);
  if (steps.length === 0) return;
  const graphPlan = buildAppGraph(input.plan, steps);
  if (graphPlan._tag === "Cycle") return yield* planError(input, graphPlan.edges);
  const parentId = `build-app-${String(input.plan.id)}`;
  const bucket = yield* openAppBuildResults(input.stateStore, BuildOwner.fromPlan(input.plan)).pipe(
    mapFailures((cause) => buildResultsError(input.provider.id, cause)),
  );
  const cached =
    (yield* bucket.get.pipe(mapFailures((cause) => buildResultsError(input.provider.id, cause)))) ?? [];
  yield* input.events.publish(
    TaskTreeStartEvent.make({
      parentId,
      label: "Building app dependencies",
      children: steps.map(({ step }) => step.id),
      mode: "list",
      timestamp: yield* timestamp,
    }),
  );
  const started = performance.now();
  const startedIds = new Set<string>();
  const settledIds = new Set<string>();
  const succeededIds = new Set<string>();
  const failures = new Map<string, BuildStepFailedError>();
  const gateEvidence = new Map<string, AppBuildGateResult>();
  const blockingGates = new Map<string, readonly string[]>();
  let treeSettled = false;

  const stepExecution: AppStepExecution = {
    parentId,
    bucket,
    cached,
    force: options.force ?? false,
    startedIds,
    settledIds,
    succeededIds,
    failures,
    dispatched: false,
  };
  const runStep = makeAppStepExecution(input, stepExecution);

  const execution = Effect.gen(function* () {
    const nodeById = new Map(graphPlan.graph.nodes.map((node) => [node.id, node.value]));
    const gateDetail = (blockedBy: ReadonlyArray<string>): string | undefined => {
      for (const id of blockedBy) {
        const node = nodeById.get(id);
        const listener = gateEvidence.get(id)?.listener;
        const service = node?._tag === "gate" ? input.plan.services[node.service] : undefined;
        if (listener !== undefined && service !== undefined)
          return listenerDiagnostic(listener, service).finding;
      }
      return undefined;
    };
    const settled = yield* runDependencySchedule(graphPlan.graph, {
      concurrency: Math.max(1, Math.min(4, availableParallelism())),
      run: (node, blockedBy) => {
        if (node.value._tag === "gate")
          return runAppBuildGate(input, node.value, options.signal).pipe(
            Effect.map((result) => {
              gateEvidence.set(node.id, result);
              return result.outcome;
            }),
          );
        blockingGates.set(node.value.appStep.step.id, blockedBy);
        const labels = blockedBy.map((id) => {
          const blockedNode = nodeById.get(id);
          if (blockedNode?._tag === "gate") {
            return gateId(String(blockedNode.service), blockedNode.condition);
          }
          if (blockedNode?._tag === "step") return blockedNode.appStep.step.id;
          return id;
        });
        return runStep(node.value.appStep, labels, gateDetail(blockedBy));
      },
    });
    if (settled._tag === "Cycle") return yield* planError(input, settled.edges);
    const ordered = steps.flatMap(({ step }) => {
      const failure = failures.get(step.id);
      return failure === undefined ? [] : [failure];
    });
    yield* input.events.publish(
      TaskTreeCompleteEvent.make({
        parentId,
        summary: ordered.length === 0 ? "App dependencies built" : "App dependency build failed",
        succeeded: steps.length - ordered.length,
        failed: ordered.length,
        durationMs: performance.now() - started,
        timestamp: yield* timestamp,
      }),
    );
    treeSettled = true;
    if (ordered.length > 0) {
      const blockers = ordered.flatMap((failure) => blockingGates.get(failure.step.id) ?? []);
      const primaryGate = graphPlan.graph.nodes.find(
        (node) => node.value._tag === "gate" && blockers.includes(node.id),
      );
      const evidence = primaryGate === undefined ? undefined : gateEvidence.get(primaryGate.id);
      const listener = evidence?.listener;
      const service =
        primaryGate?.value._tag === "gate" ? input.plan.services[primaryGate.value.service] : undefined;
      const diagnostic =
        listener !== undefined && service !== undefined ? listenerDiagnostic(listener, service) : undefined;
      const action =
        diagnostic?.action ??
        (primaryGate?.value._tag === "gate" && primaryGate.value.condition === "service_healthy"
          ? listenerAuthorityAction(service)
          : undefined);
      // Each failure carries its own remediation; repeating the first one here would print it twice.
      const remediation = "Fix each failed build step and rebuild.";
      yield* new BuildPhaseFailedError({
        app: {
          kind: isScratchPlan(input.plan) ? "scratch" : "user",
          id: input.plan.id,
          root: input.plan.root,
        },
        phase: "app",
        message: `App build failed: ${ordered.length} of ${steps.length} build steps failed.`,
        failures: ordered,
        ...(listener === undefined ? {} : { listener }),
        remediation:
          action === undefined || service === undefined
            ? remediation
            : input.redaction.redactor.redactString(
                `${action}\n${diagnostic?.authority === undefined ? "" : `${diagnostic.authority}\n`}${dependencyGateRemediation(input.plan, service.name)}`,
              ),
      });
    }
  });
  const interruptOnAbort =
    options.signal === undefined
      ? execution
      : Effect.raceFirst(
          execution,
          Effect.callback<void>((resume) => {
            const signal = options.signal;
            if (signal === undefined) return;
            if (signal.aborted) {
              resume(Effect.interrupt);
              return;
            }
            const abort = () => resume(Effect.interrupt);
            signal.addEventListener("abort", abort, { once: true });
            return Effect.sync(() => signal.removeEventListener("abort", abort));
          }),
        );
  yield* interruptOnAbort.pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit) || treeSettled) return Effect.void;
      const summary = Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed";
      return Effect.uninterruptible(
        Effect.exit(
          Effect.gen(function* () {
            for (const { step } of steps) {
              if (settledIds.has(step.id)) continue;
              // A step that never started has no transcript to advertise.
              if (!startedIds.has(step.id)) {
                yield* input.events.publish(
                  TaskStartEvent.make({
                    taskId: step.id,
                    parentId,
                    label: `Build ${String(step.service)}`,
                    timestamp: yield* timestamp,
                  }),
                );
              }
              yield* input.events.publish(
                TaskFailEvent.make({
                  taskId: step.id,
                  summary: `${step.id} ${summary}`,
                  exitCode: 1,
                  durationMs: performance.now() - started,
                  timestamp: yield* timestamp,
                }),
              );
            }
            yield* input.events.publish(
              TaskTreeCompleteEvent.make({
                parentId,
                summary: `App dependency build ${summary}`,
                succeeded: succeededIds.size,
                failed: steps.length - succeededIds.size,
                durationMs: performance.now() - started,
                timestamp: yield* timestamp,
              }),
            );
          }),
        ).pipe(Effect.asVoid),
      );
    }),
  );
  // Only a phase that succeeded and dispatched work can leave an unreferenced transcript behind;
  // a failed, interrupted, or fully reused phase keeps every transcript.
  if (stepExecution.dispatched) {
    yield* sweepAppBuildTranscripts({
      providerId: input.provider.id,
      userDataRoot: input.paths.roots.userDataRoot,
      owner: BuildOwner.fromPlan(input.plan),
      phase: "app",
      stateStore: input.stateStore,
      redact: (text) => input.redaction.redactor.redactString(text),
    });
  }
});
