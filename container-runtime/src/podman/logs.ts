import { type LogFileAccess, followLogSources, logFollowLineChunks } from "@lando/sdk/log-follow";
import type { AppPlan, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { LogChunk, LogOptions, LogTarget, ProviderError } from "@lando/sdk/services";
import { DateTime, Effect, Option, type Scope, Stream } from "effect";
import type { EngineHttpApi, EngineHttpRequest, ProviderErrorContext } from "../engine-api.ts";
import { missingApi, missingService } from "../engine-errors.ts";
import { serviceContainerName } from "../plan.ts";
import { decodeLogStream } from "../streams.ts";

export interface LogsOptions {
  readonly api?: EngineHttpApi;
  /** Shared access, or a scoped acquisition run once per followed source. */
  readonly logFileAccess?: LogFileAccess | Effect.Effect<LogFileAccess, ProviderError, Scope.Scope>;
  readonly ctx: ProviderErrorContext;
}

const stream = (
  deps: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
  input: EngineHttpRequest,
): Stream.Stream<Uint8Array, ProviderError> =>
  deps.api.stream === undefined ? Stream.fail(missingApi(deps.ctx, "logs")) : deps.api.stream(input);

export const containerConsoleLogs = (
  api: EngineHttpApi,
  ctx: ProviderErrorContext,
  container: string,
  service: ServiceName,
  options: Partial<LogOptions>,
): Stream.Stream<LogChunk, ProviderError> => {
  const selected = options.sources?.find((source) => source.id === options.source);
  const pipe = selected?.strategy === "follow" ? undefined : selected?.stream;
  const query = new URLSearchParams({
    stdout: String(pipe === undefined || pipe === "stdout"),
    stderr: String(pipe === undefined || pipe === "stderr"),
    follow: String(options.follow ?? true),
    timestamps: "true",
  });
  if (options.tail !== undefined) query.set("tail", String(options.tail));
  if (options.since !== undefined) query.set("since", options.since);
  return decodeLogStream(
    stream(
      { api, ctx },
      {
        method: "GET",
        path: `/containers/${encodeURIComponent(container)}/logs?${query}`,
      },
    ),
  ).pipe(
    Stream.filter((line) => pipe === undefined || line.stream === pipe),
    Stream.map((line) => ({ service, ...line, ...(selected === undefined ? {} : { source: selected.id }) })),
  );
};

const fileSourceSince = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = DateTime.make(value);
  return Option.isNone(parsed) ? undefined : Math.floor(DateTime.toEpochMillis(parsed.value) / 1000);
};

const serviceLogs = (
  service: ServicePlan,
  options: Partial<LogOptions>,
  runtime: LogsOptions & { readonly api: EngineHttpApi; readonly container: string },
): Stream.Stream<LogChunk, ProviderError> => {
  const { api, ctx, logFileAccess, container } = runtime;
  const logSources = options.sources ?? service.logSources ?? [];
  const selected = logSources.find((source) => source.id === options.source);
  if (selected !== undefined && selected.strategy !== "follow") {
    return containerConsoleLogs(api, ctx, container, service.name, { ...options, sources: [selected] });
  }
  const since = fileSourceSince(options.since);

  return Stream.suspend(() => {
    const fileStream =
      logFileAccess === undefined || !logSources.some((source) => source.strategy === "follow")
        ? Stream.empty
        : logFollowLineChunks(
            followLogSources({
              service: service.name,
              sources: logSources,
              follow: options.follow ?? true,
              access: logFileAccess,
              ...(options.tail === undefined ? {} : { tail: options.tail }),
              ...(since === undefined ? {} : { since }),
              ...(options.source === undefined ? {} : { source: options.source }),
            }),
          );

    if (options.source !== undefined) {
      return fileStream;
    }

    const consoleStream = containerConsoleLogs(api, ctx, container, service.name, options);

    return Stream.merge(consoleStream, fileStream);
  });
};

/** A planned service with no container (never started, or destroyed) has no logs. */
export const logs = (
  plan: AppPlan,
  target: LogTarget,
  options: Partial<LogOptions>,
  runtime: LogsOptions,
): Stream.Stream<LogChunk, ProviderError> =>
  Stream.suspend(() => {
    const ctx = runtime.ctx;
    const service = plan.services[target.service];
    if (service === undefined) {
      return Stream.fail(missingService(ctx, target, "logs"));
    }
    const api = runtime.api;
    if (api?.request === undefined) {
      return Stream.fail(missingApi(ctx, "logs"));
    }
    const container = serviceContainerName(plan, service.name);
    return Stream.unwrap(
      api
        .request({ method: "GET", path: `/containers/${encodeURIComponent(container)}/json` })
        .pipe(
          Effect.map((response) =>
            response.status === 404
              ? Stream.empty
              : serviceLogs(service, options, { ...runtime, api, container }),
          ),
        ),
    );
  }).pipe(Stream.withSpan("RuntimeProvider.logs"));
