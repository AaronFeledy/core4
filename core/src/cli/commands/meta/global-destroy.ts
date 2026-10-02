import { Effect, Schema } from "effect";

import { GlobalDestroyConfirmationError, type ProxyError } from "@lando/sdk/errors";

import {
  type AppPlanner,
  type FileSystem,
  type GlobalAppService,
  type ProviderError,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { type LoadGlobalPlanError, loadGlobalPlan } from "@lando/engine/operations/global-plan";
import { MANAGED_PROVIDER_SELECT_PLAN } from "@lando/engine/providers/managed";

export interface GlobalDestroyOptions {
  readonly yes?: boolean;
  readonly purge?: boolean;
}

export interface GlobalDestroyResult {
  readonly app: string;
  readonly materialized: boolean;
  readonly servicesDestroyed: ReadonlyArray<string>;
  readonly volumesRemoved: boolean;
}

export const GlobalDestroyResultSchema = Schema.Struct({
  app: Schema.String,
  materialized: Schema.Boolean,
  servicesDestroyed: Schema.Array(Schema.String),
  volumesRemoved: Schema.Boolean,
});

type GlobalDestroyError = LoadGlobalPlanError | GlobalDestroyConfirmationError | ProviderError | ProxyError;

type GlobalDestroyServices =
  | AppPlanner
  | FileSystem
  | GlobalAppService
  | RuntimeProviderRegistry
  | RouterService;

const confirmationError = (): GlobalDestroyConfirmationError =>
  new GlobalDestroyConfirmationError({
    message: "Destroying the global Lando app requires confirmation.",
    remediation: "Re-run with --yes to confirm.",
  });

export const renderGlobalDestroyResult = (result: GlobalDestroyResult): string => {
  if (!result.materialized) return "Global app is not installed; nothing to destroy.";
  const services =
    result.servicesDestroyed.length === 0 ? "no services" : result.servicesDestroyed.join(", ");
  const trailer = result.volumesRemoved ? "volumes removed" : "volumes preserved";
  return `destroyed: ${result.app} - ${services} (${trailer})`;
};

export const globalDestroy = (
  options: GlobalDestroyOptions = {},
): Effect.Effect<GlobalDestroyResult, GlobalDestroyError, GlobalDestroyServices> =>
  Effect.gen(function* () {
    if (options.yes !== true) return yield* Effect.fail(confirmationError());

    const loaded = yield* loadGlobalPlan();
    const volumes = options.purge ?? false;
    if (!loaded.materialized) {
      return { app: "global", materialized: false, servicesDestroyed: [], volumesRemoved: volumes };
    }

    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(MANAGED_PROVIDER_SELECT_PLAN);
    const servicesDestroyed = Object.values(loaded.plan.services)
      .reverse()
      .map((service) => String(service.name));

    yield* provider.destroy({ app: loaded.plan.id, plan: loaded.plan }, { volumes, removeState: true });
    const router = yield* RouterService;
    yield* router.removeRoutes(loaded.plan.id);

    return { app: loaded.plan.name, materialized: true, servicesDestroyed, volumesRemoved: volumes };
  });
