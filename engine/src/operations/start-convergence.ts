import { ROLE_LABEL } from "@lando/container-runtime/labels";
import { type AdoptionReceipt, ownsServiceContainer } from "@lando/container-runtime/native-ownership";
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

/** The one human notice for services the Landofile no longer defines. */
const removalNotice = (services: ReadonlyArray<string>): string => {
  const names = services.join(", ");
  const one = services.length === 1;
  return `${names} ${one ? "is" : "are"} no longer defined in the Landofile, so Lando removed ${one ? "its container" : "their containers"}. Named volumes were kept.`;
};

/** The deduplicated, sorted union of every removed-service list an operation collected. */
export const mergeRemovedServices = (
  ...groups: ReadonlyArray<ReadonlyArray<string> | undefined>
): ReadonlyArray<string> => [...new Set(groups.flatMap((group) => group ?? []))].sort();

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
 * Removes service containers this app owns that its desired plan no longer names.
 *
 * Runs only for whole-app starts. The caller passes the app's pre-apply observations, so start
 * pays one list round trip for convergence and its own before/after comparison. Every candidate
 * is ownership-prevalidated before anything is removed, so a contradictory container fails
 * closed with nothing changed. Completed removals stay committed even when a later removal or
 * the apply fails; a retry rediscovers the rest from labels.
 */
export const convergeRemovedServices = Effect.fn("AppOperation.convergeRemovedServices")(function* <
  AdmissionE,
  AdmissionR,
  ReceiptError,
>(
  plan: AppPlan,
  provider: Pick<RuntimeProviderShape, "bringDownObserved">,
  execution: {
    readonly app: AppRef;
    readonly events: EventService["Service"];
    readonly observations: ReadonlyArray<ServiceRuntimeInfo>;
    readonly receipts: Effect.Effect<readonly AdoptionReceipt[], ReceiptError>;
    readonly verifyAdmission: Effect.Effect<void, AdmissionE, AdmissionR>;
  },
): Effect.fn.Return<
  ReadonlyArray<string>,
  ProviderError | EventError | AdmissionE | ReceiptError,
  AdmissionR | EventService
> {
  const desired = new Set(Object.values(plan.services).map((service) => String(service.name)));
  const appRoot = planAppIdentity(plan).appRoot;
  const observations = execution.observations;
  const candidates = observations
    .filter(
      (observation) =>
        // A service still in the applied record whose container is already gone has nothing to
        // remove; the complete apply drops it from the record.
        observation.containerId !== undefined &&
        observation.app === plan.id &&
        observation.appRoot === appRoot &&
        !desired.has(String(observation.service)) &&
        observation.labels?.[ROLE_LABEL] === undefined,
    )
    .sort((left, right) => String(left.service).localeCompare(String(right.service)));
  if (candidates.length === 0) return [];

  const receipts = plan.identity?.dataRoot === undefined ? [] : yield* execution.receipts;
  const foreign = candidates.find((observation) => !ownsServiceContainer(plan, observation, receipts));
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
        const result = yield* provider.bringDownObserved(observation, "remove");
        if (result.action === "removed") removed.push(String(observation.service));
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
