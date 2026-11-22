import type { AppPlan, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProviderShape, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Duration, Effect } from "effect";

/** Observation stops after this budget; a service that has not answered by then is left out. */
export const SERVICE_OBSERVATION_BUDGET = Duration.seconds(1);

export interface ServiceObservation {
  readonly status: ServiceRuntimeInfo["status"];
  readonly containerId?: string;
}

/**
 * Inspects services concurrently within one shared budget, for reports that must not slow the
 * command or claim more than the runtime said. Acquiring the provider counts against the same
 * budget. A missing service is observed as `absent`; any other failure, defect, or the deadline
 * leaves that service out, so no caller reads silence as stopped.
 */
export const observeServices = <E, R>(
  acquireProvider: Effect.Effect<Pick<RuntimeProviderShape, "inspect">, E, R>,
  plan: AppPlan,
  services: ReadonlyArray<ServiceName>,
): Effect.Effect<ReadonlyMap<string, ServiceObservation>, never, R> =>
  Effect.suspend(() => {
    // Keep each completed observation even when the shared deadline interrupts its siblings.
    const observed = new Map<string, ServiceObservation>();
    return Effect.flatMap(acquireProvider, (provider) =>
      Effect.forEach(
        services,
        (service) =>
          Effect.suspend(() => provider.inspect({ app: plan.id, service, plan })).pipe(
            Effect.map(
              (runtime): ServiceObservation =>
                runtime.containerId === undefined
                  ? { status: runtime.status }
                  : { status: runtime.status, containerId: runtime.containerId },
            ),
            Effect.catchTag("ServiceNotFoundError", () =>
              Effect.succeed<ServiceObservation>({ status: "absent" }),
            ),
            Effect.tap((observation) => Effect.sync(() => observed.set(String(service), observation))),
            Effect.ignoreCause,
          ),
        { concurrency: "unbounded", discard: true },
      ),
    ).pipe(
      Effect.interruptible,
      Effect.timeoutOption(SERVICE_OBSERVATION_BUDGET),
      Effect.ignoreCause,
      Effect.as(observed),
    );
  });
