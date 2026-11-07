import { ProviderInternalError } from "@lando/sdk/errors";
import { PostServiceStopEvent, PreServiceStopEvent } from "@lando/sdk/events";
import { type AppPlan, ProviderId, type ServicePlan } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";
import { type Context, DateTime, Effect } from "effect";
import type { EngineHttpApi, ProviderErrorContext } from "../engine-api.ts";
import { containerOwnershipLabels, inspectOwnedNativeId } from "../native-ownership.ts";
import { serviceContainerName } from "../plan.ts";
import { retainShutdownObservations, stopAndRemoveContainer } from "../stop-container.ts";

export const stopService = Effect.fnUntraced(function* (
  plan: AppPlan,
  service: ServicePlan,
  options: {
    readonly api: EngineHttpApi;
    readonly ctx: ProviderErrorContext;
    readonly eventService?: Pick<Context.Service.Shape<typeof EventService>, "publish">;
  },
) {
  const providerId = ProviderId.make(options.ctx.providerId);
  const publish = (event: Parameters<Context.Service.Shape<typeof EventService>["publish"]>[0]) =>
    options.eventService === undefined
      ? Effect.void
      : options.eventService.publish(event).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderInternalError({
                providerId: options.ctx.providerId,
                operation: "bringDown.event",
                message: `Failed to publish lifecycle event: ${event._tag}`,
                remediation: options.ctx.remediation,
                cause,
              }),
          ),
        );
  const fields = {
    appRef: { kind: "user" as const, id: plan.id, root: plan.root },
    serviceName: service.name,
    providerId,
  };
  yield* publish(
    PreServiceStopEvent.make({ ...fields, eventName: "pre-service-stop", timestamp: yield* DateTime.now }),
  );
  const containerId = yield* inspectOwnedNativeId(
    options.api,
    {
      kind: "container",
      name: serviceContainerName(plan, service.name),
      labels: containerOwnershipLabels(plan, service.name),
    },
    options.ctx,
  );
  const result = yield* stopAndRemoveContainer(
    {
      appId: plan.id,
      providerId,
      service: service.name,
      ...(containerId === undefined ? {} : { containerId }),
    },
    options,
  );
  yield* publish(
    PostServiceStopEvent.make({ ...fields, eventName: "post-service-stop", timestamp: yield* DateTime.now }),
  ).pipe(Effect.mapError((error) => retainShutdownObservations(error, result.shutdownObservations)));
  return result;
});
