import { Effect } from "effect";

import type { ProxyError, RouterWatcherError } from "@lando/sdk/errors";
import { RouterService } from "@lando/sdk/services";

import {
  type GlobalStartError,
  type GlobalStartResult,
  GlobalStartResultSchema,
  type GlobalStartServices,
  globalStart,
} from "./global-start";
import { type GlobalStopError, type GlobalStopServices, globalStop } from "./global-stop";

export interface GlobalRestartOptions {
  readonly signal?: AbortSignal;
}

export type GlobalRestartResult = GlobalStartResult;
export const GlobalRestartResultSchema = GlobalStartResultSchema;

export type GlobalRestartError = GlobalStartError | GlobalStopError | ProxyError | RouterWatcherError;
export type GlobalRestartServices = GlobalStartServices | GlobalStopServices | RouterService;

export const renderGlobalRestartResult = (result: GlobalRestartResult): string => {
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  return `restarted: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};

export const globalRestart = (
  options: GlobalRestartOptions = {},
): Effect.Effect<GlobalRestartResult, GlobalRestartError, GlobalRestartServices> =>
  Effect.gen(function* () {
    yield* globalStop();
    const result = yield* globalStart(options.signal === undefined ? {} : { signal: options.signal });
    // The router is the reason this command is prescribed as a recovery step,
    // so re-observe its startup here: without it a restart cannot affect the
    // persisted observation doctor keeps reporting.
    const router = yield* RouterService;
    yield* router.revalidateStartup;
    return result;
  });
