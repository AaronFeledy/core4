import { Stream } from "effect";

import { type ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import { type LogFileAccess, followLogSources, logFollowLineChunks } from "@lando/sdk/log-follow";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { LogChunk, LogOptions, LogTarget, ProviderError } from "@lando/sdk/services";

import type { EngineHttpApi, EngineHttpRequest, ProviderErrorContext } from "../engine-api.ts";
import { missingApi } from "../engine-errors.ts";
import { makeLogDecoder as makeRuntimeLogDecoder } from "../streams.ts";

export interface LogsOptions {
  readonly api?: EngineHttpApi;
  readonly logFileAccess?: LogFileAccess;
  readonly ctx: ProviderErrorContext;
}

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const apiRequired = (ctx: ProviderErrorContext): ProviderUnavailableError =>
  missingApi(ctx, "logs", `provider-${ctx.providerId} logs requires a Podman API client.`);

const missingService = (ctx: ProviderErrorContext, target: LogTarget) =>
  new ServiceNotFoundError({
    providerId: ctx.providerId,
    operation: "logs",
    service: target.service,
    message: `Service ${target.service} is not present in the app plan.`,
  });

const stream = (
  deps: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
  input: EngineHttpRequest,
): Stream.Stream<Uint8Array, ProviderError> =>
  deps.api.stream === undefined ? Stream.fail(apiRequired(deps.ctx)) : deps.api.stream(input);

const parseLine = (service: ServicePlan, streamName: "stdout" | "stderr", line: string): LogChunk => {
  const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/u.exec(line);
  if (match === null) {
    return { service: service.name, stream: streamName, line };
  }

  const timestamp = new Date(match[1] ?? "");
  if (Number.isNaN(timestamp.getTime())) {
    return { service: service.name, stream: streamName, line };
  }

  return { service: service.name, stream: streamName, line: match[2] ?? "", timestamp };
};

const makeLogsDecoder = (service: ServicePlan) =>
  makeRuntimeLogDecoder({ parseLine: (streamName, line) => parseLine(service, streamName, line) });

const fileSourceSince = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? undefined : Math.floor(timestamp / 1000);
};

export const logs = (
  plan: AppPlan,
  target: LogTarget,
  options: Partial<LogOptions>,
  runtime: LogsOptions,
): Stream.Stream<LogChunk, ProviderError> => {
  const ctx = runtime.ctx;
  const service = plan.services[target.service];
  if (service === undefined) {
    return Stream.fail(missingService(ctx, target));
  }
  if (runtime.api === undefined) {
    return Stream.fail(apiRequired(ctx));
  }

  const query = new URLSearchParams({
    stdout: "true",
    stderr: "true",
    follow: String(options.follow ?? true),
    timestamps: "true",
  });
  if (options.tail !== undefined) {
    query.set("tail", String(options.tail));
  }
  if (options.since !== undefined) {
    query.set("since", options.since);
  }

  const deps = { api: runtime.api, ctx };
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

    const decodeChunk = makeLogsDecoder(service);
    const consoleStream = stream(deps, {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/logs?${query}`,
    }).pipe(Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))));

    return Stream.merge(consoleStream, fileStream);
  });
};
