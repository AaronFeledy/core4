import type { ScheduleOutcome } from "@lando/container-runtime/dependency-schedule";
import { effectiveReadiness } from "@lando/sdk/schema";
import { Effect } from "effect";
import { makeHealthcheckRunner } from "../subsystems/healthcheck/runner-factory.ts";
import type { AppNode } from "./build-app-graph.ts";
import type { AppBuildInput } from "./build-app-step-runner.ts";

export const runAppBuildGate = (
  input: AppBuildInput,
  gate: Extract<AppNode, { readonly _tag: "gate" }>,
  signal?: AbortSignal,
): Effect.Effect<ScheduleOutcome> => {
  const service = gate.service;
  switch (gate.condition) {
    case "service_started":
      return Effect.succeed<ScheduleOutcome>("succeeded");
    case "service_healthy": {
      const candidate = input.plan.services[service];
      const readiness = candidate === undefined ? undefined : effectiveReadiness(candidate);
      if (readiness === undefined || readiness.kind !== "command" || readiness.command === undefined)
        return Effect.succeed<ScheduleOutcome>("failed");
      return makeHealthcheckRunner({
        exec: input.provider.exec,
        ...(input.hostProbeRunners === undefined ? {} : { runners: input.hostProbeRunners }),
        ...(signal === undefined ? {} : { signal }),
      })
        .run(readiness, input.plan.id, service, input.plan)
        .pipe(
          Effect.map((result): ScheduleOutcome => (result.healthy ? "succeeded" : "failed")),
          Effect.catch(() => Effect.succeed<ScheduleOutcome>("failed")),
        );
    }
    case "service_completed_successfully":
      return Effect.scoped(
        input.provider.waitForExit(
          { app: input.plan.id, service },
          signal === undefined ? undefined : { signal },
        ),
      ).pipe(
        Effect.map((result): ScheduleOutcome => (result.exitCode === 0 ? "succeeded" : "failed")),
        Effect.catch(() => Effect.succeed<ScheduleOutcome>("failed")),
      );
  }
};
