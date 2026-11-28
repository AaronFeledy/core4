import { completionIntentServices } from "@lando/container-runtime/dependency-gates";
import type {
  AppPlan,
  RouteEvidence,
  ServiceContainerChange,
  ServiceState,
  StartedService,
} from "@lando/sdk/schema";
import {
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { Effect } from "effect";
import { routerEnabled } from "../config/router-config.ts";
import { routeOwnerFromPlan } from "../lifecycle/route-owner.ts";
import {
  observedPublicationConnection,
  projectServiceConnections,
  serviceStateOf,
} from "./service-connections.ts";
import { projectServiceRoutes } from "./service-routes.ts";

export interface ServiceAddressObservation {
  readonly name: string;
  readonly state: ServiceState;
  readonly runtime?: Pick<ServiceRuntimeInfo, "publications">;
}

export interface ObservedService extends ServiceAddressObservation {
  readonly runtime: ServiceRuntimeInfo;
}

export type CollectedService = StartedService;

export const observePlanRoutes = Effect.fnUntraced(function* (plan: AppPlan) {
  const router = yield* Effect.serviceOption(RouterService);
  return router._tag === "Some" && plan.routes.length > 0
    ? yield* router.value
        .observeRoutes(routeOwnerFromPlan(plan), plan.routes)
        .pipe(Effect.catchTag("ProxyError", () => Effect.succeed(undefined)))
    : undefined;
});

export const projectObservedServices = (
  plan: AppPlan,
  rows: readonly ServiceAddressObservation[],
  routeEvidence: RouteEvidence | undefined,
) => {
  const enabled = routerEnabled(plan);
  const services = Object.values(plan.services);
  return rows.map((row): CollectedService => {
    const service = services.find((service) => String(service.name) === row.name);
    const publications = row.runtime?.publications ?? { status: "unknown" };
    return {
      name: row.name,
      state: row.state,
      connections:
        service === undefined
          ? publications.status === "present"
            ? publications.bindings.map((binding) => observedPublicationConnection(binding, row.state))
            : []
          : projectServiceConnections({
              plan,
              service,
              state: row.state,
              publications,
            }),
      routes:
        service === undefined
          ? []
          : projectServiceRoutes({
              service,
              state: row.state,
              routes: plan.routes,
              routerEnabled: enabled,
              ...(routeEvidence === undefined ? {} : { routeEvidence }),
            }),
    };
  });
};

export const collectObservedConnections = Effect.fn("Connections.collectObserved")(function* (
  plan: AppPlan,
  rows: readonly ServiceAddressObservation[],
) {
  const routeEvidence = yield* observePlanRoutes(plan);
  return projectObservedServices(plan, rows, routeEvidence);
});

export const observeService = (plan: AppPlan, runtime: ServiceRuntimeInfo): ObservedService => ({
  name: String(runtime.service),
  runtime,
  state: serviceStateOf(runtime, completionIntentServices(plan).has(String(runtime.service))),
});

export const collectPlanObservations = Effect.fn("Connections.observePlan")(function* (
  plan: AppPlan,
  completionPlan: AppPlan = plan,
  selectedProvider?: RuntimeProviderShape,
) {
  const provider = selectedProvider ?? (yield* (yield* RuntimeProviderRegistry).select(plan));
  return yield* Effect.forEach(Object.values(plan.services), (service) =>
    provider.inspect({ app: plan.id, service: service.name, plan }).pipe(
      Effect.catchTag("ServiceNotFoundError", () =>
        Effect.succeed<ServiceRuntimeInfo>({
          app: plan.id,
          service: service.name,
          providerId: plan.provider,
          status: "absent",
          publications: { status: "missing" },
        }),
      ),
      Effect.map((runtime) => observeService(completionPlan, runtime)),
    ),
  );
});

export const collectPlanConnections = Effect.fn("Connections.collectPlan")(function* (
  plan: AppPlan,
  observations?: readonly ObservedService[],
  completionPlan: AppPlan = plan,
) {
  const rows = observations ?? (yield* collectPlanObservations(plan, completionPlan));
  return yield* collectObservedConnections(plan, rows);
});

export const startedServices = (
  rows: readonly CollectedService[],
  containers?: Readonly<Record<string, ServiceContainerChange>>,
): readonly StartedService[] =>
  rows.map(({ name, state, connections, routes }) => {
    const container = containers?.[name];
    return { name, state, connections, routes, ...(container === undefined ? {} : { container }) };
  });
