/**
 * `lando logs` — stream app logs.
 *
 * Supports `--service`, `--follow`, `--tail`. Bootstrap level: `app`.
 */
import { Effect, Stream } from "effect";

import type {
  AppIdReservedError,
  CapabilityError,
  LandoCommandError,
  LandofileIncludeError,
  LandofileLockMismatchError,
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
import { ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  type LogChunk,
  type ProviderError,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { loadUserLandofile } from "../app-resolution.ts";

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
  | AppIdReservedError
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileValidationError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NotImplementedError
  | CapabilityError
  | LandoCommandError
  | NoProviderInstalledError
  | ProviderConfigError
  | ProviderError
  | ProviderUnavailableError
  | ToolingExecError;

type LogsAppServices = AppPlanner | LandofileService | RuntimeProviderRegistry;

export const renderLogsAppResult = (result: LogsAppResult): string => {
  if (result.lines.length === 0) return `${result.app} (no log lines)`;
  return result.lines.map((line) => `${line.service} ${line.stream}: ${line.line}`).join("\n");
};

const unknownServiceError = (requested: string, plan: AppPlan): ToolingExecError => {
  const available = Object.values(plan.services)
    .map((service) => String(service.name))
    .sort();
  return new ToolingExecError({
    message:
      available.length === 0
        ? `logs: service ${requested} is not in the app plan.`
        : `logs: service ${requested} is not in the app plan (available: ${available.join(", ")}).`,
    tool: "app:logs",
  });
};

const selectServices = (
  plan: AppPlan,
  filter?: string,
): Effect.Effect<ReadonlyArray<ServicePlan>, ToolingExecError> => {
  const services = Object.values(plan.services);
  if (filter === undefined) return Effect.succeed(services);
  const matched = services.filter((service) => String(service.name) === filter);
  if (matched.length === 0) return Effect.fail(unknownServiceError(filter, plan));
  return Effect.succeed(matched);
};

export const logsApp = (
  options: LogsAppOptions = {},
): Effect.Effect<LogsAppResult, LogsAppError, LogsAppServices> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;

    const landofile = yield* loadUserLandofile(landofileService);
    const capabilities = yield* registry.capabilities;
    const plan = yield* planner.plan(landofile, capabilities);
    const services = yield* selectServices(plan, options.service);
    const provider = yield* registry.select(plan);

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
