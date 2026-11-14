import { availableParallelism } from "node:os";
import { gateId } from "@lando/container-runtime/dependency-gates";
import { runDependencySchedule } from "@lando/container-runtime/dependency-schedule";
import { listenerAuthorityAction, listenerDiagnostic } from "@lando/container-runtime/listener-diagnostic";
import { dependencyGateRemediation } from "@lando/container-runtime/podman/bring-up";
import { BuildPhaseFailedError, ProviderInternalError } from "@lando/sdk/errors";
import type { BuildAppOptions } from "@lando/sdk/services";
import { Effect } from "effect";

import { validateHealthcheckExecution } from "../subsystems/healthcheck/attempt.ts";
import { type AppBuildGateResult, runAppBuildGate } from "./build-app-gates.ts";
import { buildAppGraph } from "./build-app-graph.ts";
import { isScratchPlan } from "./build-app-kind.ts";
import { appSteps } from "./build-app-plan.ts";
import { makeAppBuildSettlement } from "./build-app-settlement.ts";
import { makeAppStepExecution } from "./build-app-step-execution.ts";
import type { AppBuildInput } from "./build-app-step-runner.ts";
import { BuildOwner } from "./build-owner.ts";
import { sweepAppBuildTranscripts } from "./build-transcript-cleanup.ts";

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
  const settlement = makeAppBuildSettlement(input, steps);
  const gateEvidence = new Map<string, AppBuildGateResult>();
  const blockingGates = new Map<string, readonly string[]>();
  const execution = Effect.gen(function* () {
    const cache = yield* settlement.load;
    const runStep = makeAppStepExecution(input, cache, options.force ?? false);
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
        return settlement.run(
          node.value.appStep,
          runStep(node.value.appStep, { labels, detail: gateDetail(blockedBy) }),
        );
      },
    });
    if (settled._tag === "Cycle") return yield* planError(input, settled.edges);
    const ordered = settlement.failures();
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
  yield* settlement.startTree.pipe(
    Effect.uninterruptible,
    Effect.andThen(interruptOnAbort),
    Effect.onExit(settlement.finalize),
  );
  // Only a phase that succeeded and dispatched work can leave an unreferenced transcript behind;
  // a failed, interrupted, or fully reused phase keeps every transcript.
  if (settlement.dispatched()) {
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
