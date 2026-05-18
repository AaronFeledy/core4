/**
 * `lando logs` — stream app logs.
 *
 * Supports `--service`, `--follow`, `--tail`. Bootstrap level: `app`.
 */
import { Effect, Stream } from "effect";

import type {
  CapabilityError,
  LandoCommandError,
  LandofileNotFoundError,
  LandofileParseError,
  LandofileValidationError,
  NoProviderInstalledError,
  NotImplementedError,
  ProviderConfigError,
  ProviderUnavailableError,
} from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  type LogChunk,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

export interface LogsAppOptions {
  readonly service?: string;
  readonly follow?: boolean;
  readonly tail?: number;
}

export interface LogsAppLine {
  readonly service: string;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
  readonly timestamp?: number;
}

export interface LogsAppResult {
  readonly app: string;
  readonly lines: ReadonlyArray<LogsAppLine>;
}

type LogsAppError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | NotImplementedError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError;

type LogsAppServices = AppPlanner | LandofileService | RuntimeProviderRegistry;

export const renderLogsAppResult = (result: LogsAppResult): string => {
  if (result.lines.length === 0) return `${result.app} (no log lines)`;
  return result.lines.map((line) => `${line.service} ${line.stream}: ${line.line}`).join("\n");
};

const selectServices = (
  services: ReadonlyArray<ServicePlan>,
  filter?: string,
): ReadonlyArray<ServicePlan> => {
  if (filter === undefined) return services;
  return services.filter((service) => String(service.name) === filter);
};

export const logsApp = (
  options: LogsAppOptions = {},
): Effect.Effect<LogsAppResult, LogsAppError, LogsAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;

    const landofile = yield* landofileService.discover;
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);
    const provider = yield* registry.select(plan);

    const services = selectServices(Object.values(plan.services), options.service);

    const perService = yield* Effect.forEach(services, (service) =>
      provider
        .logs(
          { app: plan.id, service: service.name },
          { follow: options.follow ?? false, ...(options.tail === undefined ? {} : { tail: options.tail }) },
        )
        .pipe(Stream.runCollect),
    );

    const lines: LogsAppLine[] = [];
    for (const chunk of perService) {
      for (const entry of chunk as Iterable<LogChunk>) {
        lines.push({
          service: String(entry.service),
          stream: entry.stream,
          line: entry.line,
          ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp.getTime() }),
        });
      }
    }

    return { app: plan.name, lines };
  });
