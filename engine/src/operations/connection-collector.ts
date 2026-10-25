import { completionIntentServices } from "@lando/container-runtime/dependency-gates";
import type { AppPlan, ServiceState, StartedService } from "@lando/sdk/schema";
import { RouterService, RuntimeProviderRegistry, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect } from "effect";
import { routerEnabled } from "../config/router-config.ts";
import {
  observedPublicationConnection,
  projectServiceConnections,
  serviceState,
} from "./service-connections.ts";

export interface ObservedService {
  readonly name: string;
  readonly state: ServiceState;
  readonly runtime: ServiceRuntimeInfo;
}

export type CollectedService = StartedService;

export const collectObservedConnections = Effect.fn("Connections.collectObserved")(function* (
  plan: AppPlan,
  rows: readonly ObservedService[],
) {
  const router = yield* Effect.serviceOption(RouterService);
  const enabled = routerEnabled(plan);
  const routeEvidence =
    router._tag === "Some" && plan.routes.length > 0
      ? yield* router.value
          .observeRoutes(plan.id, plan.routes)
          .pipe(Effect.catchTag("ProxyError", () => Effect.succeed(undefined)))
      : undefined;
  const services = Object.values(plan.services);
  return rows.map((row): CollectedService => {
    const service = services.find((service) => String(service.name) === row.name);
    return {
      name: row.name,
      state: row.state,
      connections:
        service === undefined
          ? row.runtime.publications.status === "present"
            ? row.runtime.publications.bindings.map((binding) =>
                observedPublicationConnection(binding, row.state),
              )
            : []
          : projectServiceConnections({
              plan,
              service,
              state: row.state,
              publications: row.runtime.publications,
              routes: plan.routes,
              routerEnabled: enabled,
              ...(routeEvidence === undefined ? {} : { routeEvidence }),
            }),
    };
  });
});

export const observeService = (plan: AppPlan, runtime: ServiceRuntimeInfo): ObservedService => ({
  name: String(runtime.service),
  runtime,
  state:
    completionIntentServices(plan).has(String(runtime.service)) &&
    (runtime.state ?? runtime.status) === "stopped" &&
    runtime.exitCode === 0
      ? "completed"
      : (runtime.state ?? runtime.status) === "completed"
        ? "stopped"
        : serviceState(runtime.state ?? runtime.status),
});

export const collectPlanConnections = Effect.fn("Connections.collectPlan")(function* (
  plan: AppPlan,
  observations?: readonly ObservedService[],
  completionPlan: AppPlan = plan,
) {
  const rows =
    observations ??
    (yield* Effect.gen(function* () {
      const provider = yield* (yield* RuntimeProviderRegistry).select(plan);
      return yield* Effect.forEach(Object.values(plan.services), (service) =>
        provider
          .inspect({ app: plan.id, service: service.name, plan })
          .pipe(Effect.map((runtime) => observeService(completionPlan, runtime))),
      );
    }));
  return yield* collectObservedConnections(plan, rows);
});

export const startedServices = (rows: readonly CollectedService[]): readonly StartedService[] =>
  rows.map(({ name, state, connections }) => ({ name, state, connections }));
