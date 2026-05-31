/**
 * `lando rebuild` — rebuild the current app's artifacts and restart.
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

export interface RebuildAppOptions {
  readonly signal?: AbortSignal;
}

export interface RebuildAppResult {
  readonly app: string;
  readonly servicesRebuilt: ReadonlyArray<string>;
  readonly servicesStarted: StartAppResult["servicesStarted"];
}

type RebuildAppError =
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

type RebuildAppServices =
  | AppPlanner
  | EventService
  | FileSystem
  | GlobalAppService
  | LandofileService
  | PluginRegistry
  | RuntimeProviderRegistry;

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
): Effect.Effect<RebuildAppResult, RebuildAppError, RebuildAppServices> =>
  Effect.gen(function* () {
    yield* stopApp();
    const start = yield* startApp({
      reconcile: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      app: start.app,
      servicesRebuilt: start.servicesStarted.map((service) => service.name),
      servicesStarted: start.servicesStarted,
    };
  });
