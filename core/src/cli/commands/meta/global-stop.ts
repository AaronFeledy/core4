import { Effect } from "effect";

import type {
  CapabilityError,
  GlobalAppError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
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

export interface GlobalStopResult {
  readonly app: string;
  readonly materialized: boolean;
  readonly servicesStopped: ReadonlyArray<string>;
}

type GlobalStopError =
  | CapabilityError
  | FileSystemError
  | GlobalAppError
  | LandofileParseError
  | LandofileValidationError
  | NoProviderInstalledError
  | NotImplementedError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type GlobalStopServices = AppPlanner | FileSystem | GlobalAppService | RuntimeProviderRegistry;

export const renderGlobalStopResult = (result: GlobalStopResult): string => {
  if (!result.materialized) return "Global app is not installed; nothing to stop.";
  const services = result.servicesStopped.length === 0 ? "no services" : result.servicesStopped.join(", ");
  return `stopped: ${result.app} - ${services}`;
};

export const globalStop = (): Effect.Effect<GlobalStopResult, GlobalStopError, GlobalStopServices> =>
  Effect.gen(function* () {
    const loaded = yield* loadGlobalPlan();
    if (!loaded.materialized) return { app: "global", materialized: false, servicesStopped: [] };

    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(loaded.plan);
    const servicesStopped = Object.values(loaded.plan.services)
      .reverse()
      .map((service) => String(service.name));

    yield* provider.destroy(
      { app: loaded.plan.id, plan: loaded.plan },
      { volumes: false, removeState: false },
    );

    return { app: loaded.plan.name, materialized: true, servicesStopped };
  });
