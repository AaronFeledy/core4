// allow: SIZE_OK — Keep the three Docker transports together for this behavior-preserving extraction; curl retirement is a separate change.
import { createConnection, isIP } from "node:net";
import { type ConnectionOptions, connect as createTlsConnection } from "node:tls";
import { ProviderCapabilityError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect, Stream } from "effect";
import type {
  EngineApiClient,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { engineApiFailure } from "../engine-errors.ts";
import { withApiReason } from "../redact.ts";
import {
  type SocketHttpConnection,
  connectSocket,
  makeSocketHttpClient,
  normalizeNamedPipePath,
} from "../transport.ts";

export const DOCKER_API_PREFIX = "/v1.43" as const;
export type DockerApiClient = EngineApiClient;
export type DockerHttpRequest = EngineHttpRequest;
export type DockerHttpResponse = EngineHttpResponse;

const unavailable = (ctx: ProviderErrorContext) => (operation: string, message: string, details?: unknown) =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation,
    message: withApiReason(message, details),
    ...(details === undefined ? {} : { details }),
  });

const parseInfoJson = (response: DockerHttpResponse, ctx: ProviderErrorContext) =>
  Effect.try({
    try: (): unknown => (response.body.length === 0 ? {} : JSON.parse(response.body)),
    catch: (cause) =>
      new ProviderCapabilityError({
        providerId: ctx.providerId,
        operation: "capabilities",
        message: "Docker API returned malformed info JSON.",
        capability: "docker-info",
        requiredValue: "valid JSON Docker info response",
        actualValue: response.body,
        cause,
      }),
  });

const collectRequestStdin = async (
  stdin: AsyncIterable<Uint8Array> | undefined,
): Promise<Uint8Array | undefined> => {
  if (stdin === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const payload = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
};

interface WritableStdinSink {
  write(payload: Uint8Array): unknown;
  end(): unknown;
}

const writeStdinPayload = (
  stdin: WritableStdinSink | null | undefined,
  payload: Uint8Array | undefined,
): void => {
  if (stdin === undefined || stdin === null || payload === undefined) return;
  stdin.write(payload);
  stdin.end();
};

const dockerApiFailure =
  (ctx: ProviderErrorContext) =>
  (request: DockerHttpRequest, cause: unknown): ProviderUnavailableError | ProviderInternalError =>
    engineApiFailure(ctx, "docker-api", request, cause);

export const makeNamedPipeTransportClient = (
  pipePath: string,
  connect?: (path: string) => Promise<SocketHttpConnection>,
) =>
  makeSocketHttpClient({
    apiPrefix: DOCKER_API_PREFIX,
    operation: "docker-api",
    connect: async () => {
      if (connect !== undefined) return connect(pipePath);
      const socket = createConnection({ path: pipePath });
      await connectSocket(socket);
      return socket;
    },
  });

export const makeTcpTransportClient = (
  baseUrl: string,
  connect?: (target: ConnectionOptions) => Promise<SocketHttpConnection>,
) => {
  const parsed = new URL(baseUrl);
  const secure = parsed.protocol === "https:";
  return makeSocketHttpClient({
    apiPrefix: parsed.pathname.replace(/\/+$/u, "") || DOCKER_API_PREFIX,
    operation: "docker-api",
    hostHeader: parsed.host,
    connect: async () => {
      const port = parsed.port === "" ? (secure ? 443 : 80) : Number(parsed.port);
      const target = secure
        ? {
            host: parsed.hostname,
            port,
            ...(isIP(parsed.hostname) === 0 ? { servername: parsed.hostname } : {}),
            rejectUnauthorized: process.env.DOCKER_TLS_VERIFY !== "0",
          }
        : { host: parsed.hostname, port };
      if (connect !== undefined) return connect(target);
      const socket = secure ? createTlsConnection(target) : createConnection(target);
      await connectSocket(socket);
      return socket;
    },
  });
};

async function* streamUnixSocketRequest(
  socketPath: string,
  request: DockerHttpRequest,
): AsyncGenerator<Uint8Array> {
  const client = makeSocketHttpClient({
    apiPrefix: DOCKER_API_PREFIX,
    operation: "docker-api",
    connect: async () => {
      const socket = createConnection({ path: socketPath });
      await connectSocket(socket);
      return socket;
    },
  });
  yield* client.stream(request);
}

async function* streamHttpRequest(
  baseUrl: string,
  request: DockerHttpRequest,
  ctx: ProviderErrorContext,
): AsyncGenerator<Uint8Array> {
  const parsed = new URL(baseUrl);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const client = makeTcpTransportClient(baseUrl);
    yield* client.stream(request);
    return;
  }
  if (request.stdin !== undefined) {
    throw unavailable(ctx)(
      "docker-api",
      "Docker stream transport does not support interactive stdin for this Docker host URL.",
      {
        method: request.method,
        path: request.path,
        protocol: parsed.protocol,
      },
    );
  }

  throw unavailable(ctx)("docker-api", "Docker stream transport does not support this Docker host URL.", {
    method: request.method,
    path: request.path,
    protocol: parsed.protocol,
  });
}

export const makeUnixDockerApiClient = (
  socketPath: string,
  ctx: ProviderErrorContext,
  options?: { readonly spawn?: typeof Bun.spawn },
): DockerApiClient => ({
  stream: (input) =>
    Stream.fromAsyncIterable(streamUnixSocketRequest(socketPath, input), (cause) =>
      dockerApiFailure(ctx)(input, cause),
    ),
  request: (input) =>
    Effect.gen(function* () {
      const args = [
        "--silent",
        "--show-error",
        "--unix-socket",
        socketPath,
        "--request",
        input.method,
        "--write-out",
        "\n%{http_code}",
      ];
      if (input.body !== undefined) {
        args.push("--header", "Content-Type: application/json", "--data", JSON.stringify(input.body));
      }
      for (const [key, value] of Object.entries(input.headers ?? {})) {
        args.push("--header", `${key}: ${value}`);
      }
      if (input.stdin !== undefined) {
        args.push("--data-binary", "@-");
      }
      args.push(`http://localhost${DOCKER_API_PREFIX}${input.path}`);

      const { stdout, stderr, exitCode } = yield* Effect.tryPromise({
        try: async () => {
          const payload = await collectRequestStdin(input.stdin);
          const proc = (options?.spawn ?? Bun.spawn)(["curl", ...args], {
            stderr: "pipe",
            stdin: payload === undefined ? "ignore" : "pipe",
            stdout: "pipe",
          });
          writeStdinPayload(proc.stdin, payload);
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { stdout, stderr, exitCode };
        },
        catch: (cause) => dockerApiFailure(ctx)(input, cause),
      });
      if (exitCode !== 0) {
        yield* Effect.fail(
          unavailable(ctx)("docker-api", `Docker API request failed with exit code ${exitCode}.`, {
            method: input.method,
            path: input.path,
            stderr,
          }),
        );
      }

      const marker = stdout.lastIndexOf("\n");
      const statusText = marker === -1 ? stdout : stdout.slice(marker + 1);
      const status = Number.parseInt(statusText, 10);
      if (!Number.isInteger(status)) {
        yield* Effect.fail(
          new ProviderInternalError({
            providerId: ctx.providerId,
            operation: "docker-api",
            message: "Docker API response did not include an HTTP status code.",
            details: stdout,
          }),
        );
      }
      return { status, body: marker === -1 ? "" : stdout.slice(0, marker) };
    }),
  info: Effect.gen(function* () {
    const response = yield* makeUnixDockerApiClient(socketPath, ctx, options).request?.({
      method: "GET",
      path: "/info",
    }) ?? Effect.fail(unavailable(ctx)("capabilities", "Docker API request client is missing."));
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        unavailable(ctx)("capabilities", `Docker info failed with HTTP ${response.status}.`, response),
      );
    }
    return yield* parseInfoJson(response, ctx);
  }),
});

export const makeNamedPipeDockerApiClient = (
  pipePath: string,
  ctx: ProviderErrorContext,
): DockerApiClient => {
  const client = makeNamedPipeTransportClient(pipePath);
  return {
    stream: (input) =>
      Stream.fromAsyncIterable(client.stream(input), (cause) => dockerApiFailure(ctx)(input, cause)),
    request: (input) =>
      Effect.tryPromise({
        try: () => client.request(input),
        catch: (cause) => dockerApiFailure(ctx)(input, cause),
      }),
    info: Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => client.request({ method: "GET", path: "/info" }),
        catch: (cause) => dockerApiFailure(ctx)({ method: "GET", path: "/info" }, cause),
      });
      if (response.status < 200 || response.status >= 300) {
        yield* Effect.fail(
          unavailable(ctx)("capabilities", `Docker info failed with HTTP ${response.status}.`, response),
        );
      }
      return yield* parseInfoJson(response, ctx);
    }),
  };
};

export const makeHttpDockerApiClient = (baseUrl: string, ctx: ProviderErrorContext): DockerApiClient => ({
  stream: (input) =>
    Stream.fromAsyncIterable(streamHttpRequest(baseUrl, input, ctx), (cause) =>
      dockerApiFailure(ctx)(input, cause),
    ),
  request: (input) =>
    Effect.tryPromise({
      try: () => makeTcpTransportClient(baseUrl).request(input),
      catch: (cause) => dockerApiFailure(ctx)(input, cause),
    }),
  info: Effect.gen(function* () {
    const response = yield* makeHttpDockerApiClient(baseUrl, ctx).request?.({
      method: "GET",
      path: "/info",
    }) ?? Effect.fail(unavailable(ctx)("capabilities", "Docker API request client is missing."));
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        unavailable(ctx)("capabilities", `Docker info failed with HTTP ${response.status}.`, response),
      );
    }
    return yield* parseInfoJson(response, ctx);
  }),
});

export const makeDockerApiClient = (
  dockerHost: string,
  ctx: ProviderErrorContext,
  options?: { readonly spawn?: typeof Bun.spawn },
): DockerApiClient => {
  if (dockerHost.startsWith("npipe:"))
    return makeNamedPipeDockerApiClient(normalizeNamedPipePath(dockerHost), ctx);
  if (dockerHost.startsWith("unix://") || dockerHost.startsWith("/")) {
    const socketPath = dockerHost.startsWith("unix://") ? dockerHost.slice("unix://".length) : dockerHost;
    return makeUnixDockerApiClient(socketPath, ctx, options);
  }
  const baseUrl = dockerHost.startsWith("tcp://")
    ? `http://${dockerHost.slice("tcp://".length)}${DOCKER_API_PREFIX}`
    : dockerHost.startsWith("http://") || dockerHost.startsWith("https://")
      ? `${dockerHost.replace(/\/+$/u, "")}${DOCKER_API_PREFIX}`
      : dockerHost;
  return makeHttpDockerApiClient(baseUrl, ctx);
};
