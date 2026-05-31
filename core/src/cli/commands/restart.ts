/**
 * `lando restart` — `stop` + `start`.
 *
 * Bootstrap level: `app`.
 */
import { Effect } from "effect";

import type {
  AppIdReservedError,
  CapabilityError,
  EventError,
  FileSyncDriftError,
  FileSyncStartError,
  FileSyncStopError,
  GlobalAutoStartError,
  LandoCommandError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import type {
  AppPlanner,
  EventService,
  FileSystem,
  GlobalAppService,
  LandofileService,
  PluginRegistry,
  ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { type StartAppResult, startApp } from "./start.ts";
import { stopApp } from "./stop.ts";

export interface RestartAppOptions {
  readonly reconcile?: boolean;
  readonly signal?: AbortSignal;
}

export interface RestartAppResult {
  readonly app: string;
  readonly servicesStarted: StartAppResult["servicesStarted"];
}

type RestartAppError =
  | AppIdReservedError
  | EventError
  | FileSyncDriftError
  | FileSyncStartError
  | FileSyncStopError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | NotImplementedError
  | CapabilityError
  | GlobalAutoStartError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

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
