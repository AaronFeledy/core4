import { Effect, Result } from "effect";
import { mapFailures } from "../command-result/failure.ts";
import { ServiceStartError } from "../errors/provider.ts";
import { type AppPlan, ServiceName } from "../schema/index.ts";
import type { RuntimeProviderShape } from "../services/index.ts";
import { TEST_SERVICE_NAME, makeTestServicePlan, mapProviderFailure, requireContract } from "./_shared.ts";

export const checkHealthyDependencyContinuation = Effect.fnUntraced(function* (
  provider: RuntimeProviderShape,
  plan: AppPlan,
) {
  if (provider.healthyDependencyContinuation !== true) return;
  const dependency = ServiceName.make("dependency");
  const consumer = TEST_SERVICE_NAME;
  const service = makeTestServicePlan(plan.provider);
  const gated: AppPlan = {
    ...plan,
    services: {
      [consumer]: {
        ...service,
        dependsOn: [{ service: dependency, condition: "service_healthy", required: true }],
      },
      [dependency]: {
        ...service,
        name: dependency,
        primary: false,
        readiness: {
          kind: "command",
          command: ["true"],
          executionTarget: "host",
          intervalSeconds: 0,
          timeoutSeconds: 3,
          retries: 1,
        },
      },
    },
  };
  yield* Effect.gen(function* () {
    const block = new ServiceStartError({
      providerId: provider.id,
      service: consumer,
      operation: "provider-contract-continuation",
      message: "Dependency did not complete its preparation.",
      remediation: "Prepare the dependency and retry.",
    });
    const probe = () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    let observedId: string | undefined;
    const blocked = yield* Effect.result(
      Effect.scoped(
        provider.apply(gated, {
          reconcile: false,
          executeReadinessAttempt: probe,
          continueHealthyDependency: (input) =>
            Effect.sync(() => {
              if (input.consumer === consumer && input.dependency === dependency)
                observedId = input.containerId;
              return block;
            }),
        }),
      ),
    );
    yield* requireContract(
      Result.isFailure(blocked) &&
        blocked.failure._tag === "ServiceStartError" &&
        blocked.failure.operation === block.operation,
      "required healthy dependency continuation blocks apply",
      blocked,
    );
    const retained = yield* provider
      .inspect({ app: plan.id, service: dependency, plan: gated })
      .pipe(mapFailures(mapProviderFailure("blocked apply preserves the running dependency")));
    const notStarted = yield* Effect.result(
      provider.inspect({ app: plan.id, service: consumer, plan: gated }),
    );
    yield* requireContract(
      observedId !== undefined &&
        retained.containerId === observedId &&
        retained.status === "running" &&
        (Result.isSuccess(notStarted)
          ? notStarted.success.status !== "running"
          : notStarted.failure._tag === "ServiceNotFoundError"),
      "continuation names the verified running dependency and precedes consumer start",
    );
    const ready = {
      reconcile: false,
      executeReadinessAttempt: probe,
      continueHealthyDependency: () => Effect.succeed(undefined),
    };
    yield* Effect.scoped(provider.apply(gated, ready)).pipe(
      mapFailures(mapProviderFailure("retry releases the prepared consumer")),
    );
    yield* Effect.scoped(
      provider.apply(gated, { ...ready, continueHealthyDependency: () => Effect.succeed(block) }),
    ).pipe(mapFailures(mapProviderFailure("kept consumers do not invoke their continuation")));
  }).pipe(
    Effect.ensuring(
      provider
        .bringDown({ app: plan.id, plan: gated }, { containers: "remove", volumes: false })
        .pipe(Effect.ignore),
    ),
  );
});
