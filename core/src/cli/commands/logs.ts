/**
 * `lando logs` — stream app logs.
 *
 * Supports `--service`, `--follow`, `--tail`, `--since`. Bootstrap level: `app`.
 */
import { Effect, Stream } from "effect";

import type { LogsAppError, LogsAppOptions } from "@lando/sdk/app";
import { CapabilityError, ToolingExecError } from "@lando/sdk/errors";
import type { AppPlan, ProviderCapabilities, ServicePlan } from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  type LogChunk,
  type LogOptions,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofile } from "../app-resolution.ts";
import { StreamFrameSink } from "../stream-frame-sink.ts";

export type { LogsAppError, LogsAppOptions } from "@lando/sdk/app";
export { StreamFrameSink } from "../stream-frame-sink.ts";
export type { StreamFrameSinkFrame, StreamFrameSinkShape } from "../stream-frame-sink.ts";

export interface FollowLogsAppOptions extends LogsAppOptions {
  /**
   * Optional abort hook for the follow drain. When omitted, follow streams
   * until the running fiber is interrupted (promise callers pass a signal to
   * `Effect.runPromise(effect, { signal })`); Scope cleanup releases the
   * provider log streams on either cancellation path.
   */
  readonly signal?: AbortSignal;
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

const SINCE_DURATION = /^(\d+)(s|m|h|d)$/u;
const SINCE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const DURATION_UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };

const invalidSinceError = (raw: string): ToolingExecError =>
  new ToolingExecError({
    message: `logs: invalid --since value "${raw}". Use a duration (e.g. 30s, 15m, 2h, 7d) or an RFC3339 timestamp (e.g. 2026-05-15T00:00:00Z).`,
    tool: "app:logs",
  });

const daysInUtcMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const rfc3339EpochSeconds = (raw: string): number | undefined => {
  const match = SINCE_TIMESTAMP.exec(raw);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInUtcMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
};

export const validateSince = (
  raw: string | undefined,
): Effect.Effect<{ readonly raw: string; readonly epochSeconds: number } | undefined, ToolingExecError> => {
  if (raw === undefined) return Effect.succeed(undefined);
  const duration = SINCE_DURATION.exec(raw);
  if (duration !== null) {
    const amount = Number(duration[1]);
    const unitSeconds = DURATION_UNIT_SECONDS[duration[2] ?? ""] ?? 0;
    const epochSeconds = Math.max(0, Math.floor(Date.now() / 1000) - amount * unitSeconds);
    return Effect.succeed({ raw, epochSeconds });
  }
  const timestampSeconds = rfc3339EpochSeconds(raw);
  if (timestampSeconds !== undefined) return Effect.succeed({ raw, epochSeconds: timestampSeconds });
  return Effect.fail(invalidSinceError(raw));
};

// Provider selection + serviceLogs capability gate + service filtering for an
// already-resolved plan. Requires only RuntimeProviderRegistry so out-of-band
// plan resolvers (global-app commands) reuse it without user-Landofile resolution.
const servicesForPlan = (
  plan: AppPlan,
  options: LogsAppOptions,
): Effect.Effect<
  { readonly services: ReadonlyArray<ServicePlan>; readonly provider: RuntimeProviderShape },
  LogsAppError,
  RuntimeProviderRegistry
> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(plan);
    if (provider.capabilities.serviceLogs !== true) {
      return yield* Effect.fail(
        new CapabilityError({
          message: "The app's runtime provider cannot stream service logs.",
          capability: "serviceLogs",
          providerId: provider.id,
          remediation:
            "Use a runtime provider whose capabilities advertise service log streaming (serviceLogs).",
        }),
      );
    }

    const services = yield* selectServices(plan, options.service);
    return { services, provider };
  });

const resolvePlanServices = (
  options: LogsAppOptions,
  target: ResolvedAppTarget | undefined,
): Effect.Effect<
  {
    readonly plan: AppPlan;
    readonly services: ReadonlyArray<ServicePlan>;
    readonly provider: RuntimeProviderShape;
  },
  LogsAppError,
  LogsAppServices
> =>
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;

    const plan =
      target?.plan ??
      (yield* Effect.gen(function* () {
        const landofile = yield* loadUserLandofile(landofileService);
        const capabilities: ProviderCapabilities = yield* registry.capabilities;
        return yield* planner.plan(landofile, capabilities);
      }));

    const { services, provider } = yield* servicesForPlan(plan, options);
    return { plan, services, provider };
  });

const logOptionsFor = (
  options: LogsAppOptions,
  follow: boolean,
  since: { readonly raw: string; readonly epochSeconds: number } | undefined,
): LogOptions => ({
  follow,
  ...(options.tail === undefined ? {} : { tail: options.tail }),
  ...(since === undefined ? {} : { since: String(since.epochSeconds) }),
});

const logOptionsForService = (logOptions: LogOptions, service: ServicePlan): LogOptions => ({
  ...logOptions,
  sources: service.logSources ?? [],
});

const waitForAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const raceAbort = <E, R>(
  signal: AbortSignal | undefined,
  effect: Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
  signal === undefined ? effect : Effect.raceFirst(effect, waitForAbort(signal));

const collectLogLines = (
  plan: AppPlan,
  services: ReadonlyArray<ServicePlan>,
  provider: RuntimeProviderShape,
  logOptions: LogOptions,
): Effect.Effect<LogsAppResult, LogsAppError, never> =>
  Effect.gen(function* () {
    const perService = yield* Effect.forEach(services, (service) =>
      provider
        .logs({ app: plan.id, service: service.name }, logOptionsForService(logOptions, service))
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

const drainLogFollow = (
  plan: AppPlan,
  services: ReadonlyArray<ServicePlan>,
  provider: RuntimeProviderShape,
  logOptions: LogOptions,
  signal: AbortSignal | undefined,
): Effect.Effect<LogsAppResult, LogsAppError, StreamFrameSink> =>
  Effect.gen(function* () {
    const sink = yield* StreamFrameSink;
    const streams = services.map((service) =>
      provider.logs({ app: plan.id, service: service.name }, logOptionsForService(logOptions, service)),
    );
    const drain = Stream.runForEach(
      Stream.mergeAll(streams, { concurrency: "unbounded" }),
      (chunk: LogChunk) =>
        sink.emit({ _tag: chunk.stream, chunk: chunk.line, service: String(chunk.service) }),
    );

    yield* raceAbort(signal, Effect.scoped(drain));
    return { app: plan.name, lines: [] };
  });

export const logsForPlan = (
  plan: AppPlan,
  options: LogsAppOptions = {},
): Effect.Effect<LogsAppResult, LogsAppError, RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const since = yield* validateSince(options.since);
    const { services, provider } = yield* servicesForPlan(plan, options);
    return yield* collectLogLines(plan, services, provider, logOptionsFor(options, false, since));
  });

export const followLogsForPlan = (
  plan: AppPlan,
  options: FollowLogsAppOptions = {},
): Effect.Effect<LogsAppResult, LogsAppError, RuntimeProviderRegistry | StreamFrameSink> =>
  Effect.gen(function* () {
    const since = yield* validateSince(options.since);
    const { services, provider } = yield* servicesForPlan(plan, options);
    return yield* drainLogFollow(
      plan,
      services,
      provider,
      logOptionsFor(options, true, since),
      options.signal,
    );
  });

export const logsApp = (
  options: LogsAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<LogsAppResult, LogsAppError, LogsAppServices> =>
  Effect.gen(function* () {
    const since = yield* validateSince(options.since);
    const { plan, services, provider } = yield* resolvePlanServices(options, target);
    return yield* collectLogLines(
      plan,
      services,
      provider,
      logOptionsFor(options, options.follow ?? false, since),
    );
  });

export const followLogsApp = (
  options: FollowLogsAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.Effect<LogsAppResult, LogsAppError, LogsAppServices | StreamFrameSink> =>
  Effect.gen(function* () {
    const since = yield* validateSince(options.since);
    const { plan, services, provider } = yield* resolvePlanServices(options, target);
    return yield* drainLogFollow(
      plan,
      services,
      provider,
      logOptionsFor(options, true, since),
      options.signal,
    );
  });
