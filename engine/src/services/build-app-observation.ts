import type { ProviderError } from "@lando/sdk/services";
import { Cause, Effect } from "effect";
import type { AppBuildInput } from "./build-app-step-runner.ts";

/** One memoized inspection per service in this phase; only typed failures are cache misses. */
export const makeAppBuildObservation = (input: AppBuildInput) => {
  const observations = new Map<string, Effect.Effect<string | undefined, ProviderError>>();
  return Effect.fnUntraced(function* (service: Parameters<typeof input.provider.inspect>[0]["service"]) {
    let observation = observations.get(service);
    if (observation === undefined) {
      observation = yield* Effect.cached(
        input.provider.inspect({ app: input.plan.id, service }).pipe(
          Effect.map((info) => (info.containerId === "" ? undefined : info.containerId)),
          Effect.catchCause((cause) =>
            cause.reasons.every(Cause.isFailReason) ? Effect.succeed(undefined) : Effect.failCause(cause),
          ),
        ),
      );
      observations.set(service, observation);
    }
    return yield* observation;
  });
};
