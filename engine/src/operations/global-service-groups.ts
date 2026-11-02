import { GlobalAppError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { type ApplyOptions, EnvironmentValueResolver, type RuntimeProviderShape } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { volumeCreationRecorder } from "../lifecycle/volume-initialization.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import {
  type PreparedDebuggerOverlay,
  prepareDebuggerOverlay,
  projectDebuggerOverlay,
} from "../subsystems/start-overlay-registry.ts";
import { withGlobalConsumerReservation } from "./global-consumer-lease.ts";
import { advanceGlobalRecordedPlan } from "./global-retained-plan.ts";

export const serviceGroups = (
  services: ReadonlyArray<ServicePlan>,
): ReadonlyArray<ReadonlyArray<ServicePlan>> => {
  const byName = new Map(services.map((service) => [service.name, service]));
  const remaining = new Set(services.map((service) => service.name));
  const groups: Array<ReadonlyArray<ServicePlan>> = [];
  for (const service of services) {
    if (!remaining.has(service.name)) continue;
    const members = new Set([service.name]);
    for (const name of members) {
      for (const candidate of services) {
        if (!remaining.has(candidate.name)) continue;
        if (
          candidate.name === name ||
          candidate.dependsOn.some((dependency) => dependency.service === name) ||
          byName.get(name)?.dependsOn.some((dependency) => dependency.service === candidate.name)
        ) {
          members.add(candidate.name);
          remaining.delete(candidate.name);
        }
      }
    }
    groups.push(services.filter((candidate) => members.has(candidate.name)));
  }
  return groups;
};

export const applyGlobalServiceGroups = Effect.fn("GlobalServices.applyGroups")(function* <
  E,
  R,
  AdmissionE = never,
  AdmissionR = never,
>(
  plan: AppPlan,
  apply: {
    readonly provider: RuntimeProviderShape;
    readonly services: ReadonlyArray<ServicePlan>;
    readonly options: Pick<ApplyOptions, "reconcile" | "signal">;
    readonly recordedPlan?: AppPlan;
    readonly recordedDisabledIds?: ReadonlyArray<string>;
    readonly beforeApply?: Effect.Effect<void, AdmissionE, AdmissionR>;
    readonly preparedOverlays?: PreparedDebuggerOverlay;
  },
  build: (plan: AppPlan) => Effect.Effect<AppPlan, E, R>,
) {
  const session = yield* (yield* EnvironmentValueResolver).openSession();
  const preparedOverlays =
    apply.preparedOverlays ??
    (yield* prepareDebuggerOverlay({
      ...plan,
      services: Object.fromEntries(apply.services.map((service) => [service.name, service])),
    }));
  let recordedPlan = apply.recordedPlan ?? plan;
  const outcomes = yield* Effect.forEach(
    serviceGroups(apply.services),
    (group) =>
      Effect.gen(function* () {
        const names = new Set(group.map((service) => service.name));
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const builtPlan = yield* build({
              ...plan,
              services: Object.fromEntries(
                Object.entries(plan.services).filter(([, service]) => names.has(service.name)),
              ),
            });
            if (apply.beforeApply !== undefined) yield* apply.beforeApply;
            const candidateRecordedPlan =
              apply.recordedPlan === undefined
                ? { ...recordedPlan, services: { ...recordedPlan.services, ...builtPlan.services } }
                : yield* advanceGlobalRecordedPlan(recordedPlan, builtPlan, apply.recordedDisabledIds ?? []);
            const runtimePlan = projectDebuggerOverlay(builtPlan, preparedOverlays);
            yield* withGlobalConsumerReservation(
              builtPlan,
              [...names],
              Effect.gen(function* () {
                if (apply.beforeApply !== undefined) yield* apply.beforeApply;
                return yield* Effect.scoped(
                  apply.provider.apply(runtimePlan, {
                    ...apply.options,
                    resolveServiceEnvironment: (service) => session.resolveEnvironment(service.environment),
                    onVolumeCreated: yield* volumeCreationRecorder(apply.provider, runtimePlan),
                    ...(apply.options.reconcile === true || apply.recordedPlan !== undefined
                      ? { recordedPlan: candidateRecordedPlan }
                      : {}),
                    completionPlan: candidateRecordedPlan,
                  }),
                );
              }),
            );
            recordedPlan = candidateRecordedPlan;
          }),
        );
        return { names, result };
      }),
    { concurrency: 1 },
  );
  const failures = outcomes.flatMap(({ names, result }) =>
    Result.isFailure(result) ? [{ names: [...names], error: result.failure }] : [],
  );
  const startedNames = new Set(
    outcomes.flatMap(({ names, result }) => (Result.isSuccess(result) ? [...names] : [])),
  );
  const services = Object.values(recordedPlan.services).filter((service) => startedNames.has(service.name));
  return { builtPlan: recordedPlan, services, failures };
}, Effect.scoped);

export const globalServiceGroupError = <E>(
  operation: "start" | "rebuild",
  outcome: {
    readonly services: ReadonlyArray<ServicePlan>;
    readonly failures: ReadonlyArray<{ readonly names: ReadonlyArray<string>; readonly error: E }>;
  },
): GlobalAppError | E | undefined => {
  const firstFailure = outcome.failures[0];
  if (firstFailure === undefined) return undefined;
  if (outcome.services.length === 0) return firstFailure.error;
  const failed = outcome.failures.flatMap((failure) => failure.names);
  const running = outcome.services.map((service) => service.name);
  return new GlobalAppError({
    operation,
    message: `Global ${failed.length === 1 ? "service" : "services"} ${failed.join(", ")} failed to ${operation}; ${running.join(", ")} ${running.length === 1 ? "is" : "are"} running.`,
    remediation:
      taggedErrorRemediation(firstFailure.error) ??
      (operation === "start"
        ? "Fix the error above, then run `lando global:start` to retry the global services. Run `lando doctor` if the failure persists."
        : "Fix the error above, then run `lando global:rebuild`. Run `lando doctor` if the failure persists."),
    cause: firstFailure.error,
  });
};
