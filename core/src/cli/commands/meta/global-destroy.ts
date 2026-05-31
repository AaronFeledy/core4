import { Effect } from "effect";

import {
  type CapabilityError,
  type GlobalAppError,
  GlobalDestroyConfirmationError,
  type LandofileParseError,
  type LandofileValidationError,
  type NoProviderInstalledError,
  type NotImplementedError,
  type ProviderConfigError,
  type ProviderUnavailableError,
} from "@lando/sdk/errors";
import {
  type AppPlanner,
  type FileSystem,
  type FileSystemError,
  type GlobalAppService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { loadGlobalPlan } from "./global-plan.ts";

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

type GlobalDestroyError =
  | CapabilityError
  | FileSystemError
  | GlobalAppError
  | GlobalDestroyConfirmationError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type GlobalDestroyServices = AppPlanner | FileSystem | GlobalAppService | RuntimeProviderRegistry;

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
    const provider = yield* registry.select(loaded.plan);
    const servicesDestroyed = Object.values(loaded.plan.services)
      .reverse()
      .map((service) => String(service.name));

    yield* provider.destroy({ app: loaded.plan.id, plan: loaded.plan }, { volumes, removeState: true });

    return { app: loaded.plan.name, materialized: true, servicesDestroyed, volumesRemoved: volumes };
  });
