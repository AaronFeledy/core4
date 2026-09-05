import { createConnection } from "node:net";
import { Effect, Stream } from "effect";

import { ProviderCapabilityError, ProviderUnavailableError } from "@lando/sdk/errors";

import {
  type EngineHttpRequest,
  type EngineHttpResponse,
  type PodmanApiClient,
  type ProviderErrorContext,
  isSuccessStatus,
} from "../engine-api.ts";
import { engineApiFailure } from "../engine-errors.ts";
import {
  type SocketHttpConnection,
  connectSocket,
  makeSocketHttpClient,
  normalizeNamedPipePath,
} from "../transport.ts";

export const LIBPOD_API_PREFIX = "/v6.0.0" as const;

export const isNamedPipeEndpoint = (endpoint: string): boolean =>
  endpoint.startsWith("npipe:") || endpoint.startsWith("\\\\.\\pipe\\");

const connect = async (endpoint: string): Promise<SocketHttpConnection> => {
  const socket = createConnection({ path: normalizeNamedPipePath(endpoint) });
  await connectSocket(socket);
  return {
    [Symbol.asyncIterator]: () => socket[Symbol.asyncIterator](),
    write: (data) => {
      socket.write(data);
    },
    end: () => {
      socket.end();
    },
    destroy: () => {
      socket.destroy();
    },
  };
};

const unavailableStatus = (
  ctx: ProviderErrorContext,
  operation: string,
  message: string,
  response: EngineHttpResponse,
): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation,
    message,
    details: response,
    remediation: ctx.remediation,
  });

export const makePodmanApiClient = (endpoint: string, ctx: ProviderErrorContext): PodmanApiClient => {
  const client = makeSocketHttpClient({
    apiPrefix: LIBPOD_API_PREFIX,
    operation: "podman-api",
    connect: () => connect(endpoint),
  });
  const request = (input: EngineHttpRequest) =>
    Effect.tryPromise({
      try: () => client.request(input),
      catch: (cause) => engineApiFailure(ctx, "podman-api", input, cause),
    });
  const stream = (input: EngineHttpRequest) =>
    Stream.fromAsyncIterable(client.stream(input), (cause) =>
      engineApiFailure(ctx, "podman-api", input, cause),
    );
  const infoRequest = { method: "GET", path: "/libpod/info" } as const;
  const pingRequest = { method: "GET", path: "/libpod/_ping" } as const;

  return {
    request,
    stream,
    info: request(infoRequest).pipe(
      Effect.flatMap((response) =>
        isSuccessStatus(response.status)
          ? Effect.succeed(response.body)
          : Effect.fail(
              unavailableStatus(
                ctx,
                "capabilities",
                `Podman API info request failed with HTTP ${response.status}.`,
                response,
              ),
            ),
      ),
      Effect.flatMap((body) =>
        Effect.try({
          try: (): unknown => JSON.parse(body),
          catch: (cause) =>
            new ProviderCapabilityError({
              providerId: ctx.providerId,
              operation: "capabilities",
              message: "Podman API returned malformed JSON — could not parse info response.",
              capability: "podman-info",
              requiredValue: "valid JSON Podman API info response",
              actualValue: body,
              remediation: ctx.remediation,
              cause,
            }),
        }),
      ),
    ),
    ping: request(pingRequest).pipe(
      Effect.flatMap((response) =>
        isSuccessStatus(response.status)
          ? Effect.void
          : Effect.fail(
              unavailableStatus(
                ctx,
                "capabilities",
                `Podman API ping request failed with HTTP ${response.status}.`,
                response,
              ),
            ),
      ),
    ),
  };
};
