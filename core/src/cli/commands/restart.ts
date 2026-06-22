/**
 * `lando restart` — `stop` + `start`.
 *
 * Bootstrap level: `app`.
 */
import { Effect } from "effect";

import type { RestartAppError, RestartAppOptions, RestartAppResult } from "@lando/sdk/app";
import type {
  AppPlanner,
  EventService,
  FileSystem,
  GlobalAppService,
  LandofileService,
  PluginRegistry,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { startApp } from "./start.ts";
import { stopApp } from "./stop.ts";

export type { RestartAppError, RestartAppOptions, RestartAppResult } from "@lando/sdk/app";

type RestartAppServices =
  | AppPlanner
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | PluginRegistry
  | RuntimeProviderRegistry;

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
): Effect.Effect<RestartAppResult, RestartAppError, RestartAppServices> =>
  Effect.gen(function* () {
    yield* stopApp();
    return yield* startApp({
      reconcile: options.reconcile ?? false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  });
