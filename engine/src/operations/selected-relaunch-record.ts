import { MessageInfoEvent } from "@lando/sdk/events";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";
import type { EventService, ServiceRuntimeInfo } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";

/**
 * The applied record a selected relaunch writes. A selected relaunch publishes no routes, so the
 * record keeps the previously applied route table and each selected service's previously applied
 * route references. Services and file sync otherwise come from the selected runtime plan; the
 * provider's merge carries every unselected and removed service from the previous record.
 */
export const selectedAppliedRecord = (
  desired: AppPlan,
  runtime: AppPlan,
  applied: AppPlan | undefined,
): AppPlan => {
  const { fileSyncPolicy, ...planLevel } = desired;
  const services = Object.fromEntries(
    Object.entries(runtime.services).map(([name, service]) => [
      name,
      { ...service, routes: applied?.services[ServiceName.make(name)]?.routes ?? [] },
    ]),
  );
  return {
    ...planLevel,
    routes: applied?.routes ?? [],
    services,
    fileSync: runtime.fileSync,
    // A defined policy, even one naming no selected service, lets the provider's merge carry the
    // previous record's policies for unselected services.
    ...(fileSyncPolicy === undefined
      ? {}
      : {
          fileSyncPolicy: {
            ...fileSyncPolicy,
            services: Object.fromEntries(
              Object.entries(fileSyncPolicy.services).filter(([name]) =>
                Object.hasOwn(runtime.services, name),
              ),
            ),
          },
        }),
  };
};

const joinServices = (services: ReadonlyArray<string>): string =>
  services.length <= 1
    ? (services[0] ?? "")
    : `${services.slice(0, -1).join(", ")} and ${services[services.length - 1]}`;

const replacedNotice = (services: ReadonlyArray<string>): string =>
  services.length === 1
    ? `Lando replaced ${services[0]}'s container instead of restarting it in place. Named volumes were kept.`
    : `Lando replaced the containers of ${joinServices(services)} instead of restarting them in place. Named volumes were kept.`;

const createdNotice = (services: ReadonlyArray<string>): string =>
  services.length === 1
    ? `${services[0]} had no container, so Lando created one.`
    : `${joinServices(services)} had no containers, so Lando created them.`;

/**
 * Announces a selected restart that could not keep the container in place. A replacement is proven
 * only by two nonempty, different container ids; a creation only by a prior absent status and a
 * current container id. Unknown evidence proves nothing, so it produces no notice.
 */
export const publishRelaunchNotice = Effect.fnUntraced(function* (
  events: Pick<EventService["Service"], "publish">,
  prior: ReadonlyMap<string, ServiceRuntimeInfo>,
  current: ReadonlyMap<string, ServiceRuntimeInfo>,
) {
  const replaced: string[] = [];
  const created: string[] = [];
  for (const [name, observed] of current) {
    const before = prior.get(name);
    const previousId = before?.containerId;
    const currentId = observed.containerId;
    if (currentId === undefined || currentId.length === 0) continue;
    if (previousId !== undefined && previousId.length > 0 && previousId !== currentId) {
      replaced.push(name);
    } else if (before?.status === "absent") {
      created.push(name);
    }
  }
  if (replaced.length > 0)
    yield* events.publish(
      MessageInfoEvent.make({ body: replacedNotice(replaced), timestamp: DateTime.nowUnsafe() }),
    );
  if (created.length > 0)
    yield* events.publish(
      MessageInfoEvent.make({ body: createdNotice(created), timestamp: DateTime.nowUnsafe() }),
    );
});
