/**
 * `lando restart` — `stop` + `start`.
 *
 * Bootstrap level: `app`.
 */
import { Effect, Schema } from "effect";

import type { RestartAppError, RestartAppOptions, RestartAppResult } from "@lando/sdk/app";
import type {
  AppPlanner,
  EventService,
  FileSystem,
  GlobalAppService,
  LandofileService,
  PluginRegistry,
  RuntimeProviderRegistry,
  ShellRunner,
} from "@lando/sdk/services";

import type { RedactionService } from "../../redaction/service.ts";
import type { ResolvedAppTarget } from "../app-resolution.ts";
import { type StartManagedScope, StartedServiceResultSchema, startApp } from "./start.ts";
import { stopApp } from "./stop.ts";

export type { RestartAppError, RestartAppOptions, RestartAppResult } from "@lando/sdk/app";

export const RestartAppResultSchema = Schema.Struct({
  app: Schema.String,
  servicesStarted: Schema.Array(StartedServiceResultSchema),
});

type RestartAppServices =
  | AppPlanner
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | PluginRegistry
  | RedactionService
  | RuntimeProviderRegistry
  | ShellRunner;

export const renderRestartAppResult = (result: RestartAppResult): string => {
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  return `restarted: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};

export const restartApp = (
  options: RestartAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
): Effect.Effect<RestartAppResult, RestartAppError, RestartAppServices> =>
  Effect.gen(function* () {
    yield* stopApp({}, target);
    return yield* startApp(
      {
        reconcile: options.reconcile ?? false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      target,
      managed,
    );
  });
