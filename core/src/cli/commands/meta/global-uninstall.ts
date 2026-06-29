import { Effect, Schema } from "effect";

import {
  type CapabilityError,
  GlobalAppError,
  type GlobalDistConflictError,
  type LandofileParseError,
  type LandofileValidationError,
  type NoProviderInstalledError,
  type NotImplementedError,
  type ProviderConfigError,
  type ProviderUnavailableError,
} from "@lando/sdk/errors";
import type { GlobalDistResult } from "@lando/sdk/services";
import {
  type AppPlanner,
  type FileSystem,
  type FileSystemError,
  GlobalAppService,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { loadGlobalPlan } from "./global-plan.ts";

export interface GlobalUninstallOptions {
  readonly plugin?: string;
  readonly purge?: boolean;
}

export interface GlobalUninstallResult {
  readonly app: string;
  readonly materialized: boolean;
  readonly purged: boolean;
  readonly dist: GlobalDistResult;
  readonly servicesRemoved: ReadonlyArray<string>;
}

const GlobalDistResultSchema = Schema.Struct({
  path: Schema.String,
  status: Schema.Literal("created", "updated", "unchanged"),
  serviceIds: Schema.Array(Schema.String),
});

export const GlobalUninstallResultSchema = Schema.Struct({
  app: Schema.String,
  materialized: Schema.Boolean,
  purged: Schema.Boolean,
  dist: GlobalDistResultSchema,
  servicesRemoved: Schema.Array(Schema.String),
});

type GlobalUninstallError =
  | CapabilityError
  | FileSystemError
  | GlobalAppError
  | GlobalDistConflictError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type GlobalUninstallServices = AppPlanner | FileSystem | GlobalAppService | RuntimeProviderRegistry;

const pluginUninstallError = (plugin: string): GlobalAppError =>
  new GlobalAppError({
    message: `Global service plugin uninstall for ${plugin} is not available yet.`,
    operation: "uninstall",
    remediation:
      "Plugin global-service disablement is a later deliverable; run `lando global:uninstall` with no argument to clear the generated global services.",
  });

export const renderGlobalUninstallResult = (result: GlobalUninstallResult): string => {
  const services = result.servicesRemoved.length === 0 ? "none" : result.servicesRemoved.join(", ");
  const purge = result.purged ? "provider resources and volumes removed" : "provider resources preserved";
  return [
    "Global app generated services cleared.",
    `Generated dist Landofile: ${result.dist.path} (${result.dist.status})`,
    `Services removed: ${services}`,
    purge,
  ].join("\n");
};

export const globalUninstall = (
  options: GlobalUninstallOptions = {},
): Effect.Effect<GlobalUninstallResult, GlobalUninstallError, GlobalUninstallServices> =>
  Effect.gen(function* () {
    if (options.plugin !== undefined && options.plugin !== "") {
      return yield* Effect.fail(pluginUninstallError(options.plugin));
    }

    const loaded = yield* loadGlobalPlan();
    const globalApp = yield* GlobalAppService;
    const purged = options.purge ?? false;
    const servicesRemoved = loaded.materialized
      ? Object.values(loaded.plan.services).map((service) => String(service.name))
      : [];

    if (purged && loaded.materialized) {
      const registry = yield* RuntimeProviderRegistry;
      const provider = yield* registry.select(loaded.plan);
      yield* provider.destroy(
        { app: loaded.plan.id, plan: loaded.plan },
        { volumes: true, removeState: true },
      );
    }

    const dist = yield* globalApp.regenerateDist({ services: {} });

    return { app: "global", materialized: loaded.materialized, purged, dist, servicesRemoved };
  });
