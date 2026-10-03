import { Clock, DateTime, Effect, Option, Stream } from "effect";

import type { LogsAppOptions, LogsAppError as SdkLogsAppError } from "@lando/sdk/app";
import {
  CapabilityError,
  type ComposeKeyRejectedError,
  type LandofileLoadExpressionError,
  ToolingExecError,
} from "@lando/sdk/errors";
import {
  type AppPlan,
  LogSourceId,
  type ProviderCapabilities,
  RESERVED_LOG_SOURCE_ID,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  type LogChunk,
  type LogOptions,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";

import { type ResolvedAppTarget, loadUserLandofile } from "../landofile/app-resolution.ts";
import { StreamFrameSink } from "./stream-frame-sink.ts";

export type LogsAppError = SdkLogsAppError | ComposeKeyRejectedError | LandofileLoadExpressionError;
export type { LogsAppOptions } from "@lando/sdk/app";
export { StreamFrameSink } from "./stream-frame-sink.ts";
export type { StreamFrameSinkFrame, StreamFrameSinkShape } from "./stream-frame-sink.ts";

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
  readonly source?: string;
  readonly timestamp?: number;
}

export interface LogsAppResult {
  readonly app: string;
  readonly lines: ReadonlyArray<LogsAppLine>;
}

type LogsAppServices = AppPlanner | LandofileService | RuntimeProviderRegistry;

const unknownServiceError = (requested: string, plan: AppPlan): ToolingExecError => {
  const available = Object.values(plan.services)
    .map((service) => String(service.name))
    .sort();
  const first = available[0];
  return new ToolingExecError({
    message:
      available.length === 0
        ? `logs: service ${requested} is not in the app plan.`
        : `logs: service ${requested} is not in the app plan (available: ${available.join(", ")}).`,
    tool: "app:logs",
    ...(first === undefined ? {} : { remediation: `Example: lando logs --service ${first}` }),
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

const knownSourceIds = (services: ReadonlyArray<ServicePlan>): ReadonlyArray<string> => {
  const ids = new Set<string>([RESERVED_LOG_SOURCE_ID]);
  for (const service of services) {
    for (const source of service.logSources ?? []) ids.add(String(source.id));
  }
  return [...ids].sort();
};

const validateSource = (
  requested: string | undefined,
  services: ReadonlyArray<ServicePlan>,
  serviceLogSources: boolean,
): Effect.Effect<void, ToolingExecError> => {
  if (requested === undefined) return Effect.void;
  const known = knownSourceIds(services);
  if (!known.includes(requested)) {
    return Effect.fail(
      new ToolingExecError({
        message: `logs: unknown log source "${requested}" (available: ${known.join(", ")}).`,
        tool: "app:logs",
      }),
    );
  }
  if (requested === RESERVED_LOG_SOURCE_ID || serviceLogSources) return Effect.void;
  const hasRedirectSource = services.some((service) =>
    (service.logSources ?? []).some(
      (source) => String(source.id) === requested && source.strategy === "redirect",
    ),
  );
  if (hasRedirectSource) return Effect.void;
  return Effect.fail(
    new ToolingExecError({
      message: `logs: log source "${requested}" is unavailable because the runtime provider does not advertise serviceLogSources.`,
      tool: "app:logs",
    }),
  );
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
  DateTime.getPartUtc(
    DateTime.subtract(
      DateTime.makeUnsafe({ year: year < 100 ? year + 1900 : year, month: month + 1, day: 1 }),
      { days: 1 },
    ),
    "day",
  );

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
  const parsed = DateTime.make(raw);
  return Option.isNone(parsed) ? undefined : Math.floor(DateTime.toEpochMillis(parsed.value) / 1000);
};

export const validateSince = Effect.fnUntraced(function* (
  raw: string | undefined,
): Effect.fn.Return<{ readonly raw: string; readonly epochSeconds: number } | undefined, ToolingExecError> {
  if (raw === undefined) return undefined;
  const duration = SINCE_DURATION.exec(raw);
  if (duration !== null) {
    const amount = Number(duration[1]);
    const unitSeconds = DURATION_UNIT_SECONDS[duration[2] ?? ""] ?? 0;
    const epochSeconds = Math.max(
      0,
      Math.floor((yield* Clock.currentTimeMillis) / 1000) - amount * unitSeconds,
    );
    return { raw, epochSeconds };
  }
  const timestampSeconds = rfc3339EpochSeconds(raw);
  if (timestampSeconds !== undefined) return { raw, epochSeconds: timestampSeconds };
  return yield* Effect.fail(invalidSinceError(raw));
});

const servicesForPlan = Effect.fnUntraced(function* (
  plan: AppPlan,
  options: LogsAppOptions,
): Effect.fn.Return<
  { readonly services: ReadonlyArray<ServicePlan>; readonly provider: RuntimeProviderShape },
  SdkLogsAppError,
  RuntimeProviderRegistry
> {
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
  yield* validateSource(options.source, services, provider.capabilities.serviceLogSources);
  return { services, provider };
});

const resolvePlanServices = Effect.fnUntraced(function* (
  options: LogsAppOptions,
  target: ResolvedAppTarget | undefined,
): Effect.fn.Return<
  {
    readonly plan: AppPlan;
    readonly services: ReadonlyArray<ServicePlan>;
    readonly provider: RuntimeProviderShape;
  },
  LogsAppError,
  LogsAppServices
> {
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

const logOptionsForService = (
  logOptions: LogOptions,
  service: ServicePlan,
  serviceLogSources: boolean,
  requestedSource: string | undefined,
): LogOptions => {
  const serviceSources = service.logSources ?? [];
  const capable = serviceSources.filter((source) => serviceLogSources || source.strategy !== "follow");
  if (requestedSource === undefined) return { ...logOptions, sources: capable };
  if (requestedSource === RESERVED_LOG_SOURCE_ID) return { ...logOptions, sources: [] };
  if (
    serviceSources.some((source) => String(source.id) === requestedSource && source.strategy === "redirect")
  ) {
    return { ...logOptions, sources: [] };
  }
  return {
    ...logOptions,
    sources: capable.filter((source) => String(source.id) === requestedSource),
    source: LogSourceId.make(requestedSource),
  };
};

const waitForAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
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

const collectLogLines = Effect.fnUntraced(function* (
  plan: AppPlan,
  services: ReadonlyArray<ServicePlan>,
  provider: RuntimeProviderShape,
  logOptions: LogOptions,
  requestedSource: string | undefined,
): Effect.fn.Return<LogsAppResult, SdkLogsAppError, never> {
  const perService = yield* Effect.forEach(services, (service) =>
    provider
      .logs(
        { app: plan.id, service: service.name, plan },
        logOptionsForService(logOptions, service, provider.capabilities.serviceLogSources, requestedSource),
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
        ...(entry.source === undefined ? {} : { source: String(entry.source) }),
        ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp.getTime() }),
      });
    }
  }

  return { app: plan.name, lines };
});

const drainLogFollow = Effect.fnUntraced(function* (
  plan: AppPlan,
  services: ReadonlyArray<ServicePlan>,
  provider: RuntimeProviderShape,
  logOptions: LogOptions,
  requestedSource: string | undefined,
  signal: AbortSignal | undefined,
): Effect.fn.Return<LogsAppResult, SdkLogsAppError, StreamFrameSink> {
  const sink = yield* StreamFrameSink;
  const streams = services.map((service) =>
    provider.logs(
      { app: plan.id, service: service.name, plan },
      logOptionsForService(logOptions, service, provider.capabilities.serviceLogSources, requestedSource),
    ),
  );
  const drain = Stream.runForEach(Stream.mergeAll(streams, { concurrency: "unbounded" }), (chunk: LogChunk) =>
    sink.emit({
      _tag: chunk.stream,
      chunk: chunk.line,
      service: String(chunk.service),
      ...(chunk.source === undefined ? {} : { source: String(chunk.source) }),
    }),
  );

  yield* raceAbort(signal, Effect.scoped(drain));
  return { app: plan.name, lines: [] };
});

const collectLogsForPlan = Effect.fnUntraced(function* (
  plan: AppPlan,
  options: LogsAppOptions,
  follow: boolean,
): Effect.fn.Return<LogsAppResult, SdkLogsAppError, RuntimeProviderRegistry> {
  const since = yield* validateSince(options.since);
  const { services, provider } = yield* servicesForPlan(plan, options);
  return yield* collectLogLines(
    plan,
    services,
    provider,
    logOptionsFor(options, follow, since),
    options.source,
  );
});

export const logsForPlan = Effect.fn("AppOperation.logsForPlan")(function* (
  plan: AppPlan,
  options: LogsAppOptions = {},
): Effect.fn.Return<LogsAppResult, SdkLogsAppError, RuntimeProviderRegistry> {
  return yield* collectLogsForPlan(plan, options, false);
});

export const followLogsForPlan = Effect.fn("AppOperation.followLogsForPlan")(function* (
  plan: AppPlan,
  options: FollowLogsAppOptions = {},
): Effect.fn.Return<LogsAppResult, SdkLogsAppError, RuntimeProviderRegistry | StreamFrameSink> {
  const since = yield* validateSince(options.since);
  const { services, provider } = yield* servicesForPlan(plan, options);
  return yield* drainLogFollow(
    plan,
    services,
    provider,
    logOptionsFor(options, true, since),
    options.source,
    options.signal,
  );
});

export const logsApp = Effect.fn("AppOperation.logs")(function* (
  options: LogsAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<LogsAppResult, LogsAppError, LogsAppServices> {
  const since = yield* validateSince(options.since);
  const { plan, services, provider } = yield* resolvePlanServices(options, target);
  return yield* collectLogLines(
    plan,
    services,
    provider,
    logOptionsFor(options, options.follow ?? false, since),
    options.source,
  );
});

export const logsAppForTarget = Effect.fn("AppOperation.logsForTarget")(function* (
  options: LogsAppOptions | undefined,
  target: ResolvedAppTarget,
): Effect.fn.Return<LogsAppResult, SdkLogsAppError, RuntimeProviderRegistry> {
  return yield* collectLogsForPlan(target.plan, options ?? {}, options?.follow ?? false);
});

export const followLogsApp = Effect.fn("AppOperation.followLogs")(function* (
  options: FollowLogsAppOptions = {},
  target?: ResolvedAppTarget,
): Effect.fn.Return<LogsAppResult, LogsAppError, LogsAppServices | StreamFrameSink> {
  const since = yield* validateSince(options.since);
  const { plan, services, provider } = yield* resolvePlanServices(options, target);
  return yield* drainLogFollow(
    plan,
    services,
    provider,
    logOptionsFor(options, true, since),
    options.source,
    options.signal,
  );
});
