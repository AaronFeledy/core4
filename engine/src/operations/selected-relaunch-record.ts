import { type AppPlan, ServiceName } from "@lando/sdk/schema";

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
