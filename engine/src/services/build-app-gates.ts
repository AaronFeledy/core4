import type { ScheduleOutcome } from "@lando/container-runtime/dependency-schedule";
import { observeTcpListener } from "@lando/container-runtime/listener-observation";
import { type ListenerObservation, effectiveReadiness } from "@lando/sdk/schema";
import { Effect } from "effect";
import { makeHealthcheckRunner } from "../subsystems/healthcheck/runner-factory.ts";
import type { AppNode } from "./build-app-graph.ts";
import type { AppBuildInput } from "./build-app-step-runner.ts";

export interface AppBuildGateResult {
  readonly outcome: ScheduleOutcome;
  readonly listener?: ListenerObservation;
}

export const runAppBuildGate = (
  input: AppBuildInput,
  gate: Extract<AppNode, { readonly _tag: "gate" }>,
  signal?: AbortSignal,
): Effect.Effect<AppBuildGateResult> => {
  const service = gate.service;
  switch (gate.condition) {
    case "service_started":
      return Effect.succeed({ outcome: "succeeded" });
    case "service_healthy": {
      const candidate = input.plan.services[service];
      const readiness = candidate === undefined ? undefined : effectiveReadiness(candidate);
      if (
        candidate === undefined ||
        readiness === undefined ||
        readiness.kind !== "command" ||
        readiness.command === undefined
      )
        return Effect.succeed({ outcome: "failed" });
      return makeHealthcheckRunner({
        exec: input.provider.exec,
        ...(input.hostProbeRunners === undefined ? {} : { runners: input.hostProbeRunners }),
        ...(signal === undefined ? {} : { signal }),
      })
        .run(readiness, input.plan.id, service, input.plan)
        .pipe(
          Effect.catch(() => Effect.succeed({ healthy: false })),
          Effect.flatMap((result): Effect.Effect<AppBuildGateResult> => {
            if (result.healthy) return Effect.succeed({ outcome: "succeeded" });
            return observeTcpListener(candidate, (command) =>
              input.provider.execStream({ app: input.plan.id, service, plan: input.plan }, command),
            ).pipe(
              Effect.map((listener) => ({
                outcome: "failed" as const,
                ...(listener === undefined ? {} : { listener }),
              })),
            );
          }),
        );
    }
    case "service_completed_successfully":
      return Effect.scoped(
        input.provider.waitForExit(
          { app: input.plan.id, service },
          signal === undefined ? undefined : { signal },
        ),
      ).pipe(
        Effect.map(
          (result): AppBuildGateResult => ({ outcome: result.exitCode === 0 ? "succeeded" : "failed" }),
        ),
        Effect.catch(() => Effect.succeed({ outcome: "failed" as const })),
      );
  }
};
