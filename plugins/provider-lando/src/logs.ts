import { makeLogDecoder as makeRuntimeLogDecoder } from "@lando/container-runtime/streams";
import { Stream } from "effect";

import { ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import { type LogFileAccess, followLogSources, logFollowLineChunks } from "@lando/sdk/log-follow";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { LogChunk, LogOptions, LogTarget, ProviderError } from "@lando/sdk/services";

import type { PodmanApiClient, PodmanHttpRequest } from "./capabilities.ts";

const PROVIDER_ID = "lando";
export interface LogsOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly logFileAccess?: LogFileAccess;
}

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const missingApi = () =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "logs",
    message: "provider-lando logs requires a Podman API client.",
  });

const missingService = (target: LogTarget) =>
  new ServiceNotFoundError({
    providerId: PROVIDER_ID,
    operation: "logs",
    service: target.service,
    message: `Service ${target.service} is not present in the app plan.`,
  });

const stream = (api: PodmanApiClient, input: PodmanHttpRequest): Stream.Stream<Uint8Array, ProviderError> =>
  api.stream === undefined ? Stream.fail(missingApi()) : api.stream(input);

const parseLine = (service: ServicePlan, streamName: "stdout" | "stderr", line: string): LogChunk => {
  const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/u.exec(line);
  if (match === null) {
    return { service: service.name, stream: streamName, line };
  }

  const timestampText = match[1];
  if (timestampText === undefined) {
    return { service: service.name, stream: streamName, line };
  }

  const timestamp = new Date(timestampText);
  if (Number.isNaN(timestamp.getTime())) {
    return { service: service.name, stream: streamName, line };
  }

  return { service: service.name, stream: streamName, line: match[2] ?? "", timestamp };
};

const makeLogsDecoder = (service: ServicePlan) =>
  makeRuntimeLogDecoder({ parseLine: (streamName, line) => parseLine(service, streamName, line) });

export const logs = (
  plan: AppPlan,
  target: LogTarget,
  options: Partial<LogOptions> = {},
  runtime: LogsOptions = {},
): Stream.Stream<LogChunk, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Stream.fail(missingService(target));
  }
  if (runtime.podmanApi === undefined) {
    return Stream.fail(missingApi());
  }

  const query = new URLSearchParams({
    stdout: "true",
    stderr: "true",
    follow: String(options.follow ?? true),
  });
  query.set("timestamps", "true");
  if (options.tail !== undefined) {
    query.set("tail", String(options.tail));
  }
  if (options.since !== undefined) {
    query.set("since", options.since);
  }

  const podmanApi = runtime.podmanApi;
  const logFileAccess = runtime.logFileAccess;
  const logSources = options.sources ?? service.logSources ?? [];
  const hasFollowSources = logSources.some((source) => source.strategy === "follow");
  const since = options.since === undefined ? undefined : Number(options.since);

  return Stream.suspend(() => {
    const decodeChunk = makeLogsDecoder(service);
    const consoleStream = stream(podmanApi, {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/logs?${query}`,
    }).pipe(Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))));

    if (!hasFollowSources || logFileAccess === undefined) return consoleStream;

    const fileStream = logFollowLineChunks(
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

    return Stream.merge(consoleStream, fileStream);
  });
};
