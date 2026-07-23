/**
 * `lando rebuild` — rebuild the current app's artifacts and restart.
 *
 * Bootstrap level: `app`.
 */
import { Effect, Schema } from "effect";

import type { RebuildAppError, RebuildAppOptions, RebuildAppResult } from "@lando/sdk/app";
import type {
  AppPlanResolver,
  BuildOrchestrator,
  EventService,
  FileSystem,
  GlobalAppService,
  LandofileService,
  PathsService,
  PluginRegistry,
  ProxyService,
  RuntimeProviderRegistry,
  ShellRunner,
} from "@lando/sdk/services";

import type { RedactionService } from "../../redaction/service.ts";
import type { ResolvedAppTarget } from "../app-resolution.ts";
import { type StartManagedScope, StartedServiceResultSchema, startApp } from "./start.ts";
import { stopApp } from "./stop.ts";

export type { RebuildAppError, RebuildAppOptions, RebuildAppResult } from "@lando/sdk/app";

export const RebuildAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesRebuilt: Schema.Array(Schema.String),
  servicesStarted: Schema.Array(StartedServiceResultSchema),
});

type RebuildAppServices =
  | AppPlanResolver
  | BuildOrchestrator
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | PathsService
  | PluginRegistry
  | ProxyService
  | RedactionService
  | RuntimeProviderRegistry
  | ShellRunner;

export const renderRebuildAppResult = (result: RebuildAppResult): string => {
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  return `rebuilt: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};

export const rebuildApp = (
  options: RebuildAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
): Effect.Effect<RebuildAppResult, RebuildAppError, RebuildAppServices> =>
  Effect.gen(function* () {
    yield* stopApp({}, target);
    const start = yield* startApp(
      {
        reconcile: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      target,
      managed,
      { forceAppBuild: true },
    );
    return {
      app: start.app,
      servicesRebuilt: start.servicesStarted.map((service) => service.name),
      servicesStarted: start.servicesStarted,
    };
  });
