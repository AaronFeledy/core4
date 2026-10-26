import type { ServiceNotReadyError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { publishGlobalRoutes } from "../operations/global-routes.ts";
import { globalServiceGroupError, serviceGroups } from "../operations/global-service-groups.ts";
import { waitForServiceReadiness } from "../operations/service-readiness.ts";
import type { GlobalGroups } from "./startup-completion.ts";

export const completeGlobalGroups = Effect.fn("StartupCompletion.globalGroups")(function* <E>(
  request: GlobalGroups<E>,
) {
  const { provider, outcome, signal } = request;
  const groups = yield* Effect.forEach(
    serviceGroups(outcome.services),
    (services) =>
      Effect.map(
        Effect.result(
          waitForServiceReadiness({
            provider,
            plan: outcome.builtPlan,
            services: services.map((service) => service.name),
            ...(signal === undefined ? {} : { signal }),
          }),
        ),
        (result) => ({ services, result }),
      ),
    { concurrency: "unbounded" },
  );
  const failures = [
    ...outcome.failures,
    ...groups.flatMap((group) =>
      Result.isFailure(group.result)
        ? [{ names: group.services.map((service) => String(service.name)), error: group.result.failure }]
        : [],
    ),
  ];
  const completed = {
    builtPlan: outcome.builtPlan,
    services: groups.flatMap((group) => (Result.isSuccess(group.result) ? group.services : [])),
    ready: groups.flatMap((group) => (Result.isSuccess(group.result) ? group.result.success : [])),
    failures,
  };
  const error = globalServiceGroupError<E | ServiceNotReadyError>(request.operation, completed);
  if (error !== undefined) return yield* Effect.fail(error);
  yield* publishGlobalRoutes(request.router, provider, outcome.builtPlan, {
    started: new Set(completed.services.map((service) => service.name)),
    failed: new Set(),
  });
  return completed;
});
