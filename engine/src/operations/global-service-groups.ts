import { GlobalAppError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ApplyOptions, RuntimeProviderShape } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { resolveServiceEnvironmentSecrets } from "../services/secret-environment.ts";

const serviceGroups = (services: ReadonlyArray<ServicePlan>): ReadonlyArray<ReadonlyArray<ServicePlan>> => {
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

export const applyGlobalServiceGroups = Effect.fn("GlobalServices.applyGroups")(function* <E, R>(
  plan: AppPlan,
  apply: {
    readonly provider: RuntimeProviderShape;
    readonly services: ReadonlyArray<ServicePlan>;
    readonly options: Pick<ApplyOptions, "reconcile" | "signal">;
  },
  build: (plan: AppPlan) => Effect.Effect<AppPlan, E, R>,
) {
  let recordedPlan = plan;
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
            recordedPlan = {
              ...plan,
              services: { ...recordedPlan.services, ...builtPlan.services },
            };
            const serviceEnvironment = yield* resolveServiceEnvironmentSecrets(builtPlan);
            yield* Effect.scoped(
              apply.provider.apply(builtPlan, {
                ...apply.options,
                serviceEnvironment,
                ...(apply.options.reconcile === true ? { recordedPlan } : {}),
                completionPlan: plan,
              }),
            );
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
});

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
