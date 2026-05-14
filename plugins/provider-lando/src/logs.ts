import { Stream } from "effect";

import { ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { LogChunk, LogOptions, LogTarget, ProviderError } from "@lando/sdk/services";

import type { PodmanApiClient, PodmanHttpRequest } from "./capabilities.ts";

const PROVIDER_ID = "lando";
const textDecoder = new TextDecoder();

export interface LogsOptions {
  readonly podmanApi?: PodmanApiClient;
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

const makeLogsDecoder = (service: ServicePlan) => {
  let buffer = new Uint8Array(0);

  return (chunk: Uint8Array): ReadonlyArray<LogChunk> => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;

    const decoded: LogChunk[] = [];
    while (buffer.length >= 8) {
      const streamType = buffer[0] ?? 0;
      const frameLength =
        (((buffer[4] ?? 0) << 24) | ((buffer[5] ?? 0) << 16) | ((buffer[6] ?? 0) << 8) | (buffer[7] ?? 0)) >>>
        0;
      if (buffer.length < 8 + frameLength) {
        break;
      }

      const payload = buffer.slice(8, 8 + frameLength);
      buffer = buffer.slice(8 + frameLength);

      if (streamType === 1 || streamType === 2) {
        const streamName = streamType === 1 ? "stdout" : "stderr";
        const text = textDecoder.decode(payload);
        for (const line of text.split(/\r?\n/u).filter((entry) => entry.length > 0)) {
          decoded.push(parseLine(service, streamName, line));
        }
      }
    }

    return decoded;
  };
};

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

  const decodeChunk = makeLogsDecoder(service);

  return stream(runtime.podmanApi, {
    method: "GET",
    path: `/containers/${encodeURIComponent(containerName(plan, service))}/logs?${query}`,
  }).pipe(Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))));
};
