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

type LogsDecoderMode = "unknown" | "framed" | "raw";

const parseTextLines = (
  service: ServicePlan,
  streamName: "stdout" | "stderr",
  text: string,
): { readonly chunks: ReadonlyArray<LogChunk>; readonly remainder: string } => {
  const lines = text.split(/\r?\n/u);
  const remainder = lines.pop() ?? "";
  return {
    chunks: lines.filter((entry) => entry.length > 0).map((line) => parseLine(service, streamName, line)),
    remainder,
  };
};

const makeLogsDecoder = (service: ServicePlan) => {
  let mode: LogsDecoderMode = "unknown";
  let frameBuffer = new Uint8Array(0);
  let rawBuffer = "";

  const decodeRaw = (bytes: Uint8Array): ReadonlyArray<LogChunk> => {
    mode = "raw";
    const parsed = parseTextLines(service, "stdout", rawBuffer + textDecoder.decode(bytes));
    rawBuffer = parsed.remainder;
    return parsed.chunks;
  };

  return (chunk: Uint8Array): ReadonlyArray<LogChunk> => {
    if (mode === "raw") {
      return decodeRaw(chunk);
    }

    if (chunk.length === 0) {
      return [];
    }

    const merged = new Uint8Array(frameBuffer.length + chunk.length);
    merged.set(frameBuffer);
    merged.set(chunk, frameBuffer.length);
    frameBuffer = merged;

    const firstByte = frameBuffer[0] ?? 0;
    if (mode === "unknown" && frameBuffer.length > 0 && firstByte !== 1 && firstByte !== 2) {
      const bytes = frameBuffer;
      frameBuffer = new Uint8Array(0);
      return decodeRaw(bytes);
    }
    mode = "framed";

    const decoded: LogChunk[] = [];
    while (frameBuffer.length >= 8) {
      const streamType = frameBuffer[0] ?? 0;
      const frameLength =
        (((frameBuffer[4] ?? 0) << 24) |
          ((frameBuffer[5] ?? 0) << 16) |
          ((frameBuffer[6] ?? 0) << 8) |
          (frameBuffer[7] ?? 0)) >>>
        0;
      if (frameBuffer.length < 8 + frameLength) {
        break;
      }

      const payload = frameBuffer.slice(8, 8 + frameLength);
      frameBuffer = frameBuffer.slice(8 + frameLength);

      if (streamType === 1 || streamType === 2) {
        const streamName = streamType === 1 ? "stdout" : "stderr";
        for (const line of textDecoder
          .decode(payload)
          .split(/\r?\n/u)
          .filter((entry) => entry.length > 0)) {
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

  const podmanApi = runtime.podmanApi;
  return Stream.suspend(() => {
    const decodeChunk = makeLogsDecoder(service);
    return stream(podmanApi, {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/logs?${query}`,
    }).pipe(Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))));
  });
};
