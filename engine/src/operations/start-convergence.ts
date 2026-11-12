import { ROLE_LABEL } from "@lando/container-runtime/labels";
import { ownsServiceContainer } from "@lando/container-runtime/native-ownership";
import { type EventError, ProviderUnavailableError } from "@lando/sdk/errors";
import { MessageInfoEvent, PostServiceStopEvent, PreServiceStopEvent } from "@lando/sdk/events";
import { type AppPlan, type AppRef, planAppIdentity } from "@lando/sdk/schema";
import type {
  EventService,
  ProviderError,
  RuntimeProviderShape,
  ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { DateTime, Effect, Exit } from "effect";

/** The one human notice for services removed because the Landofile no longer defines them. */
export const removalNotice = (services: ReadonlyArray<string>): string => {
  const names = services.join(", ");
  const one = services.length === 1;
  return `${names} ${one ? "is" : "are"} no longer defined in the Landofile, so Lando removed ${one ? "its container" : "their containers"}. Named volumes were kept.`;
};

const ownershipRefusal = (plan: AppPlan, observation: ServiceRuntimeInfo) => {
  const container = observation.containerId ?? String(observation.service);
  return new ProviderUnavailableError({
    providerId: String(plan.provider),
    operation: "start",
    message: `Start found container ${container} for service ${observation.service}, which ${plan.name} no longer defines, but its labels do not prove it belongs to this app at ${planAppIdentity(plan).appRoot}.`,
    remediation: `Inspect container ${container} with your container runtime and remove it if it is a leftover, then retry \`lando start\`.`,
  });
};

/**
 * Names of applied-plan services the desired plan dropped whose containers a halt is about to
 * remove. Observing before the halt proves each container exists, so a service whose container is
 * already gone is never reported. The provider is asked only when the applied plan names a dropped
 * service.
 */
export const servicesHaltWillRemove = Effect.fn("AppOperation.servicesHaltWillRemove")(function* (
  applied: AppPlan | undefined,
  desired: AppPlan,
  provider: Pick<RuntimeProviderShape, "list">,
): Effect.fn.Return<ReadonlyArray<string>, ProviderError> {
  if (applied === undefined) return [];
  const dropped = Object.keys(applied.services).filter((name) => !Object.hasOwn(desired.services, name));
  if (dropped.length === 0) return [];
  const appRoot = planAppIdentity(applied).appRoot;
  const observed = yield* provider.list({ app: applied.id, includeUnplanned: true });
  const present = new Set(
    observed
      .filter(
        (observation) =>
          observation.containerId !== undefined &&
          observation.app === applied.id &&
          observation.appRoot === appRoot,
      )
      .map((observation) => String(observation.service)),
  );
  return dropped.filter((name) => present.has(name)).sort();
});

/**
 * Removes service containers this app owns that its desired plan no longer names.
 *
 * Runs only for whole-app starts. Every candidate is ownership-prevalidated before anything is
 * removed, so a contradictory container fails closed with nothing changed. Completed removals stay
 * committed even when a later removal or the apply fails; a retry rediscovers the rest from labels.
 */
export const convergeRemovedServices = Effect.fn("AppOperation.convergeRemovedServices")(function* <
  AdmissionE,
  AdmissionR,
>(
  plan: AppPlan,
  provider: Pick<RuntimeProviderShape, "list" | "removeObservedService">,
  execution: {
    readonly app: AppRef;
    readonly events: EventService["Service"];
    readonly verifyAdmission: Effect.Effect<void, AdmissionE, AdmissionR>;
  },
): Effect.fn.Return<
  ReadonlyArray<string>,
  ProviderError | EventError | AdmissionE,
  AdmissionR | EventService
> {
  const desired = new Set(Object.values(plan.services).map((service) => String(service.name)));
  const appRoot = planAppIdentity(plan).appRoot;
  const observations = yield* provider.list({ app: plan.id, includeUnplanned: true });
  const candidates = observations
    .filter(
      (observation) =>
        // A service still in the applied record whose container is already gone (after a stop or a
        // restart's halt) has nothing to remove; the complete apply drops it from the record.
        observation.containerId !== undefined &&
        observation.app === plan.id &&
        observation.appRoot === appRoot &&
        !desired.has(String(observation.service)) &&
        observation.labels?.[ROLE_LABEL] === undefined,
    )
    .sort((left, right) => String(left.service).localeCompare(String(right.service)));
  if (candidates.length === 0) return [];

  const foreign = candidates.find((observation) => !ownsServiceContainer(plan, observation));
  if (foreign !== undefined) return yield* Effect.fail(ownershipRefusal(plan, foreign));

  yield* execution.verifyAdmission;

  const removed: string[] = [];
  const outcome = yield* Effect.forEach(
    candidates,
    (observation) =>
      Effect.gen(function* () {
        const serviceEvent = {
          appRef: execution.app,
          serviceName: observation.service,
          providerId: plan.provider,
        };
        yield* execution.events.publish(
          PreServiceStopEvent.make({
            ...serviceEvent,
            eventName: "pre-service-stop",
            timestamp: DateTime.nowUnsafe(),
          }),
        );
        const result = yield* provider.removeObservedService(observation);
        if (result.kind === "removed") removed.push(String(observation.service));
        yield* execution.events.publish(
          PostServiceStopEvent.make({
            ...serviceEvent,
            eventName: "post-service-stop",
            timestamp: DateTime.nowUnsafe(),
          }),
        );
      }),
    { discard: true },
  ).pipe(Effect.exit);

  // Removals are committed as they happen, so announce them even when a later one fails.
  if (removed.length > 0)
    yield* execution.events.publish(
      MessageInfoEvent.make({ body: removalNotice(removed), timestamp: DateTime.nowUnsafe() }),
    );
  if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
  return removed;
});
