import { availableParallelism } from "node:os";

import { gateId } from "@lando/container-runtime/dependency-gates";
import { runDependencySchedule } from "@lando/container-runtime/dependency-schedule";
import { listenerAuthorityAction, listenerDiagnostic } from "@lando/container-runtime/listener-diagnostic";
import { dependencyGateRemediation } from "@lando/container-runtime/podman/bring-up";
import { Cause, DateTime, Effect, Exit } from "effect";

import { BuildPhaseFailedError, BuildStepFailedError, ProviderInternalError } from "@lando/sdk/errors";
import {
  TaskCompleteEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { BuildStep } from "@lando/sdk/schema";
import type { BuildAppOptions } from "@lando/sdk/services";

import { validateHealthcheckExecution } from "../subsystems/healthcheck/attempt.ts";
import { type AppBuildGateResult, runAppBuildGate } from "./build-app-gates.ts";
import { buildAppGraph } from "./build-app-graph.ts";
import { type AppStep, appSteps } from "./build-app-plan.ts";
import { type AppBuildInput, runAppBuildStep } from "./build-app-step-runner.ts";
import { findCompleteBuildResult, openAppBuildResults, recordBuildResult } from "./build-results.ts";
import { makeBuildTranscriptPath } from "./build-transcript.ts";

const timestamp = DateTime.now;

const cacheError = (providerId: string, cause: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "buildResults",
    message: "Unable to access the build-results cache.",
    cause,
    remediation:
      "Re-run the command after checking provider logs; if it persists, report the internal provider error.",
  });

const planError = (input: AppBuildInput, edges: ReadonlyArray<string>) =>
  new ProviderInternalError({
    providerId: input.provider.id,
    operation: "buildAppPlan",
    message: "App build steps contain a dependency cycle.",
    details: { edges },
    remediation: "Remove the cyclic app build-step dependencies and retry.",
  });

const transcriptPathFor = (input: AppBuildInput, step: BuildStep) =>
  makeBuildTranscriptPath({
    userDataRoot: input.paths.roots.userDataRoot,
    appId: String(input.plan.id),
    phase: "app",
    serviceName: String(step.service),
    buildKey: step.buildKey,
    scratch: String(input.plan.id).startsWith("scratch-"),
  });

const appRefFor = (input: AppBuildInput) =>
  String(input.plan.id).startsWith("scratch-")
    ? ({ kind: "scratch", id: input.redactor.redactString(input.plan.slug) } as const)
    : ({ kind: "user", id: input.redactor.redactString(input.plan.slug) } as const);

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
  const bucket = yield* openAppBuildResults(input.stateStore, String(input.plan.id)).pipe(
    Effect.mapError((cause) => cacheError(input.provider.id, cause)),
  );
  const cached =
    (yield* bucket.get.pipe(Effect.mapError((cause) => cacheError(input.provider.id, cause)))) ?? [];
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

  const runStep = Effect.fnUntraced(function* (
    appStep: AppStep,
    blockedBy: ReadonlyArray<string>,
    detail: string | undefined,
  ) {
    const { step } = appStep;
    const transcriptPath = transcriptPathFor(input, step);
    startedIds.add(step.id);
    // The blocked check stays ahead of the build-results lookup: a cached step
    // must not bypass a gate or predecessor that just failed.
    if (blockedBy.length > 0) {
      const summary = `${step.id} blocked by ${blockedBy.join(", ")}${detail === undefined ? "" : `: ${detail}`}`;
      yield* input.events.publish(
        TaskStartEvent.make({
          taskId: step.id,
          parentId,
          label: `Build ${String(step.service)}`,
          transcriptPath,
          timestamp: yield* timestamp,
        }),
      );
      yield* input.events.publish({
        _tag: "build-step-skip",
        eventName: "build-step-skip",
        appRef: appRefFor(input),
        serviceName: input.redactor.redactString(step.service),
        providerId: input.redactor.redactString(input.plan.provider),
        phase: "app",
        buildKey: step.buildKey,
        cached: false,
        reason: "phase-aborted",
        timestamp: yield* timestamp,
      });
      yield* input.events.publish(
        TaskFailEvent.make({
          taskId: step.id,
          summary,
          exitCode: 1,
          durationMs: 0,
          timestamp: yield* timestamp,
        }),
      );
      settledIds.add(step.id);
      failures.set(
        step.id,
        new BuildStepFailedError({
          step,
          exitCode: 1,
          transcriptPath,
          summary,
          remediation: `Resolve the blocking failures (${blockedBy.join(", ")}), then rebuild step ${step.id}. Inspect the transcript at ${transcriptPath} if needed.`,
        }),
      );
      return "blocked" as const;
    }
    if (!options.force && findCompleteBuildResult(cached, step) !== undefined) {
      yield* input.events.publish(
        TaskStartEvent.make({
          taskId: step.id,
          parentId,
          label: `Build ${String(step.service)}`,
          transcriptPath,
          timestamp: yield* timestamp,
        }),
      );
      yield* input.events.publish({
        _tag: "build-step-skip",
        eventName: "build-step-skip",
        appRef: appRefFor(input),
        serviceName: input.redactor.redactString(step.service),
        providerId: input.redactor.redactString(input.plan.provider),
        phase: "app",
        buildKey: step.buildKey,
        cached: true,
        reason: "up-to-date",
        timestamp: yield* timestamp,
      });
      yield* input.events.publish(
        TaskCompleteEvent.make({
          taskId: step.id,
          summary: `${step.id} cached`,
          durationMs: 0,
          timestamp: yield* timestamp,
        }),
      );
      settledIds.add(step.id);
      succeededIds.add(step.id);
      return "succeeded" as const;
    }
    const result = yield* runAppBuildStep(input, appStep, transcriptPath);
    settledIds.add(step.id);
    if (result.exitCode === 0) succeededIds.add(step.id);
    yield* recordBuildResult(bucket, {
      buildKey: step.buildKey,
      service: step.service,
      phase: "app",
      outcome: result.exitCode === 0 ? "complete" : "fail",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      transcriptPath,
    }).pipe(Effect.mapError((cause) => cacheError(input.provider.id, cause)));
    if (result.exitCode === 0) return "succeeded" as const;
    failures.set(
      step.id,
      new BuildStepFailedError({
        step,
        exitCode: result.exitCode,
        transcriptPath,
        summary: `${step.id} failed`,
        remediation: `Inspect the build transcript at ${transcriptPath}, fix step ${step.id}, and rebuild.`,
      }),
    );
    return "failed" as const;
  });

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
      const remediation =
        ordered[0]?.remediation ??
        "Inspect the reported app-phase build step failures, fix them, and rebuild.";
      yield* new BuildPhaseFailedError({
        app: {
          kind: String(input.plan.id).startsWith("scratch-") ? "scratch" : "user",
          id: input.plan.id,
          root: input.plan.root,
        },
        phase: "app",
        failures: ordered,
        ...(listener === undefined ? {} : { listener }),
        remediation:
          action === undefined || service === undefined
            ? remediation
            : input.redactor.redactString(
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
              const transcriptPath = transcriptPathFor(input, step);
              if (!startedIds.has(step.id)) {
                yield* input.events.publish(
                  TaskStartEvent.make({
                    taskId: step.id,
                    parentId,
                    label: `Build ${String(step.service)}`,
                    transcriptPath,
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
});
