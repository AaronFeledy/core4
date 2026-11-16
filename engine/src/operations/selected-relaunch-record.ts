import { canonicalJson } from "@lando/sdk/digest";
import type { AppPlan } from "@lando/sdk/schema";

/**
 * The applied record a selected relaunch writes. The router replaces an owner's whole route set,
 * so the record composes the table it publishes: previously applied routes of the services the
 * relaunch did not select, in their applied order, then the selected services' desired routes.
 * Each selected service's route references are remapped onto that table. Services and file sync
 * otherwise come from the selected runtime plan; the provider's merge carries every unselected
 * and removed service from the previous record.
 */
export const selectedAppliedRecord = (
  desired: AppPlan,
  runtime: AppPlan,
  applied: AppPlan | undefined,
): AppPlan => {
  const { fileSyncPolicy, ...planLevel } = desired;
  const selected = new Set(Object.keys(runtime.services));
  const routes = [
    ...(applied?.routes ?? []).filter((route) => !selected.has(String(route.service))),
    ...desired.routes.filter((route) => selected.has(String(route.service))),
  ];
  const routeKeys = routes.map(canonicalJson);
  const services = Object.fromEntries(
    Object.entries(runtime.services).map(([name, service]) => [
      name,
      {
        ...service,
        routes: service.routes.flatMap((ref) => {
          const route = desired.routes[ref.index];
          const index = route === undefined ? -1 : routeKeys.indexOf(canonicalJson(route));
          return index < 0 ? [] : [{ index }];
        }),
      },
    ]),
  );
  return {
    ...planLevel,
    routes,
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
