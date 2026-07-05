import { Effect } from "effect";

import {
  type GlobalStartError,
  type GlobalStartResult,
  GlobalStartResultSchema,
  type GlobalStartServices,
  globalStart,
} from "./global-start.ts";
import { type GlobalStopError, type GlobalStopServices, globalStop } from "./global-stop.ts";

export interface GlobalRestartOptions {
  readonly signal?: AbortSignal;
}

export type GlobalRestartResult = GlobalStartResult;
export const GlobalRestartResultSchema = GlobalStartResultSchema;

export type GlobalRestartError = GlobalStartError | GlobalStopError;
export type GlobalRestartServices = GlobalStartServices | GlobalStopServices;

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
    return yield* globalStart(options.signal === undefined ? {} : { signal: options.signal });
  });
