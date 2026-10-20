import { DateTime, Option, Stream } from "effect";
import { serviceContainerName } from "../plan.ts";

import { type LogFileAccess, followLogSources, logFollowLineChunks } from "@lando/sdk/log-follow";
import type { AppPlan, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { LogChunk, LogOptions, LogTarget, ProviderError } from "@lando/sdk/services";

import type { EngineHttpApi, EngineHttpRequest, ProviderErrorContext } from "../engine-api.ts";
import { missingApi, missingService } from "../engine-errors.ts";
import { decodeLogStream } from "../streams.ts";

export interface LogsOptions {
  readonly api?: EngineHttpApi;
  readonly logFileAccess?: LogFileAccess;
  readonly ctx: ProviderErrorContext;
}

const containerName = (plan: AppPlan, service: ServicePlan) => serviceContainerName(plan, service.name);

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
  const query = new URLSearchParams({
    stdout: "true",
    stderr: "true",
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
  ).pipe(Stream.map((line) => ({ service, ...line })));
};

const fileSourceSince = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = DateTime.make(value);
  return Option.isNone(parsed) ? undefined : Math.floor(DateTime.toEpochMillis(parsed.value) / 1000);
};

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
    if (runtime.api === undefined) {
      return Stream.fail(missingApi(ctx, "logs"));
    }

    const api = runtime.api;
    const logFileAccess = runtime.logFileAccess;
    const logSources = options.sources ?? service.logSources ?? [];
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

      const consoleStream = containerConsoleLogs(
        api,
        ctx,
        containerName(plan, service),
        service.name,
        options,
      );

      return Stream.merge(consoleStream, fileStream);
    });
  }).pipe(Stream.withSpan("RuntimeProvider.logs"));
