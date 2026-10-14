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
import { tryParseJson } from "../engine-json.ts";
import { redactDetails, redactString, withApiReason } from "../redact.ts";
import {
  type SocketHttpClient,
  type SocketHttpConnection,
  connectSocket,
  makeSocketHttpClient,
  normalizeNamedPipePath,
  socketHttpConnection,
} from "../transport.ts";
import {
  type ResolvedDockerApiPrefix,
  dockerApiEndpointKey,
  dockerHttpBaseUrl,
  explicitDockerApiPrefixFromHost,
  isDockerApiPrefixFailure,
  learnDockerApiPrefix,
  resolveInitialDockerApiPrefix,
} from "./api-prefix.ts";
import {
  DOCKER_API_PREFIX,
  type DockerApiNegotiationFail,
  dockerApiVersionUnavailable,
} from "./api-version.ts";

export { DOCKER_API_PREFIX } from "./api-version.ts";
export {
  DOCKER_API_MAX_TESTED_VERSION,
  DOCKER_API_PREFERRED_VERSION,
  isDockerApiVersionError,
} from "./api-version.ts";
export { resetDockerApiPrefixCache } from "./api-prefix.ts";
export type { DockerApiPrefixSource } from "./api-prefix.ts";

export type DockerApiClient = EngineApiClient;
export type DockerHttpRequest = EngineHttpRequest;
export type DockerHttpResponse = EngineHttpResponse;

export interface DockerApiClientOptions {
  readonly spawn?: typeof Bun.spawn;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface DockerPrefixSession {
  readonly endpointKey: string;
  readonly explicitPrefix?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const unavailable = (ctx: ProviderErrorContext) => (operation: string, message: string, details?: unknown) =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation,
    message: redactString(withApiReason(message, details)),
    ...(details === undefined ? {} : { details: redactDetails(details) }),
  });

const parseInfoJson = (response: DockerHttpResponse, ctx: ProviderErrorContext) =>
  response.body.length === 0
    ? Effect.succeed({})
    : tryParseJson(
        response.body,
        (cause) =>
          new ProviderCapabilityError({
            providerId: ctx.providerId,
            operation: "capabilities",
            message: "Docker API returned malformed info JSON.",
            capability: "docker-info",
            requiredValue: "valid JSON Docker info response",
            actualValue: redactString(response.body),
            cause,
          }),
      );

const fetchDockerInfo = Effect.fnUntraced(function* (
  request: DockerApiClient["request"],
  ctx: ProviderErrorContext,
) {
  const response = yield* request?.({ method: "GET", path: "/info" }) ??
    Effect.fail(unavailable(ctx)("capabilities", "Docker API request client is missing."));
  if (response.status < 200 || response.status >= 300) {
    yield* Effect.fail(
      unavailable(ctx)("capabilities", `Docker info failed with HTTP ${response.status}.`, response),
    );
  }
  return yield* parseInfoJson(response, ctx);
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

const throwIfNegotiationFailed = (
  ctx: ProviderErrorContext,
  resolved: ResolvedDockerApiPrefix | DockerApiNegotiationFail,
): ResolvedDockerApiPrefix => {
  if (isDockerApiPrefixFailure(resolved)) throw dockerApiVersionUnavailable(ctx, resolved);
  return resolved;
};

const initialPrefix = (session: DockerPrefixSession, ctx: ProviderErrorContext): ResolvedDockerApiPrefix =>
  throwIfNegotiationFailed(
    ctx,
    resolveInitialDockerApiPrefix({
      endpointKey: session.endpointKey,
      preferredPrefix: DOCKER_API_PREFIX,
      ...(session.explicitPrefix === undefined ? {} : { explicitPrefix: session.explicitPrefix }),
      ...(session.env === undefined ? {} : { env: session.env }),
    }),
  );

const learnFromResponse = (
  session: DockerPrefixSession,
  used: ResolvedDockerApiPrefix,
  response: Pick<DockerHttpResponse, "status" | "body" | "headers">,
  ctx: ProviderErrorContext,
) => {
  const learned = learnDockerApiPrefix({
    endpointKey: session.endpointKey,
    usedPrefix: used.prefix,
    usedSource: used.source,
    status: response.status,
    body: response.body,
    ...(response.headers === undefined ? {} : { headers: response.headers }),
  });
  if (learned.failure !== undefined) throw dockerApiVersionUnavailable(ctx, learned.failure);
  return learned;
};

const prefixSessionForHost = (
  dockerHost: string,
  options?: DockerApiClientOptions,
  explicitPrefix = explicitDockerApiPrefixFromHost(dockerHost),
): DockerPrefixSession => ({
  endpointKey: dockerApiEndpointKey(dockerHost),
  ...(explicitPrefix === undefined ? {} : { explicitPrefix }),
  ...(options?.env === undefined ? {} : { env: options.env }),
});

export const makeNamedPipeTransportClient = (
  pipePath: string,
  connect?: (path: string) => Promise<SocketHttpConnection>,
  apiPrefix: string = DOCKER_API_PREFIX,
) =>
  makeSocketHttpClient({
    apiPrefix,
    operation: "docker-api",
    connect: async () => {
      if (connect !== undefined) return connect(pipePath);
      const socket = createConnection({ path: pipePath });
      await connectSocket(socket);
      return socketHttpConnection(socket);
    },
  });

export const makeTcpTransportClient = (
  baseUrl: string,
  connect?: (target: ConnectionOptions) => Promise<SocketHttpConnection>,
  apiPrefix?: string,
) => {
  const parsed = new URL(baseUrl);
  const secure = parsed.protocol === "https:";
  const fromPath = parsed.pathname.replace(/\/+$/u, "");
  return makeSocketHttpClient({
    apiPrefix: apiPrefix ?? (fromPath === "" ? DOCKER_API_PREFIX : fromPath),
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
      return socketHttpConnection(socket);
    },
  });
};

const parseCurlHttp = (
  stdout: string,
): {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
} => {
  const marker = stdout.lastIndexOf("\n");
  const statusText = marker === -1 ? stdout : stdout.slice(marker + 1);
  const status = Number.parseInt(statusText, 10);
  const raw = marker === -1 ? "" : stdout.slice(0, marker);
  if (!raw.startsWith("HTTP/")) return { status, body: raw };

  const separator = raw.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const split = raw.lastIndexOf(separator);
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + separator.length);
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/u)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return Object.keys(headers).length === 0 ? { status, body } : { status, body, headers };
};

const curlRequestArgs = (socketPath: string, prefix: string, input: DockerHttpRequest): string[] => {
  const args = [
    "--silent",
    "--show-error",
    "--include",
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
  args.push(`http://localhost${prefix}${input.path}`);
  return args;
};

async function* streamUnixSocketRequest(
  socketPath: string,
  request: DockerHttpRequest,
  prefix: string,
): AsyncGenerator<Uint8Array> {
  const client = makeSocketHttpClient({
    apiPrefix: prefix,
    operation: "docker-api",
    connect: async () => {
      const socket = createConnection({ path: socketPath });
      await connectSocket(socket);
      return socketHttpConnection(socket);
    },
  });
  yield* client.stream(request);
}

async function* streamHttpRequest(
  baseUrl: string,
  request: DockerHttpRequest,
  ctx: ProviderErrorContext,
  apiPrefix?: string,
): AsyncGenerator<Uint8Array> {
  const parsed = new URL(baseUrl);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const client = makeTcpTransportClient(baseUrl, undefined, apiPrefix);
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

const requestThroughClient = async (
  client: SocketHttpClient,
  input: DockerHttpRequest,
  session: DockerPrefixSession,
  used: ResolvedDockerApiPrefix,
  ctx: ProviderErrorContext,
  retryClient: (prefix: string) => SocketHttpClient,
): Promise<DockerHttpResponse> => {
  const response = await client.request(input);
  const learned = learnFromResponse(session, used, response, ctx);
  if (!learned.retry) return response;
  return retryClient(learned.prefix).request(input);
};

export const makeUnixDockerApiClient = (
  socketPath: string,
  ctx: ProviderErrorContext,
  options?: DockerApiClientOptions,
): DockerApiClient => {
  const session = prefixSessionForHost(
    socketPath.startsWith("/") ? socketPath : `unix://${socketPath}`,
    options,
  );
  const spawnCurl = async (prefix: string, input: DockerHttpRequest) => {
    const payload = await collectRequestStdin(input.stdin);
    const proc = (options?.spawn ?? Bun.spawn)(["curl", ...curlRequestArgs(socketPath, prefix, input)], {
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
  };

  return {
    stream: (input) =>
      Stream.fromAsyncIterable(
        (async function* () {
          const used = initialPrefix(session, ctx);
          yield* streamUnixSocketRequest(socketPath, input, used.prefix);
        })(),
        (cause) => dockerApiFailure(ctx)(input, cause),
      ),
    request: Effect.fn("DockerApiClient.request")(function* (input) {
      const used = yield* Effect.try({
        try: () => initialPrefix(session, ctx),
        catch: (cause) => dockerApiFailure(ctx)(input, cause),
      });
      const first = yield* Effect.tryPromise({
        try: () => spawnCurl(used.prefix, input),
        catch: (cause) => dockerApiFailure(ctx)(input, cause),
      });
      if (first.exitCode !== 0) {
        yield* Effect.fail(
          unavailable(ctx)("docker-api", `Docker API request failed with exit code ${first.exitCode}.`, {
            method: input.method,
            path: input.path,
            stderr: first.stderr,
          }),
        );
      }
      const parsed = parseCurlHttp(first.stdout);
      if (!Number.isInteger(parsed.status)) {
        yield* Effect.fail(
          new ProviderInternalError({
            providerId: ctx.providerId,
            operation: "docker-api",
            message: "Docker API response did not include an HTTP status code.",
            details: redactString(first.stdout),
          }),
        );
      }
      const learned = yield* Effect.try({
        try: () => learnFromResponse(session, used, parsed, ctx),
        catch: (cause) => dockerApiFailure(ctx)(input, cause),
      });
      if (!learned.retry) return parsed;
      const retry = yield* Effect.tryPromise({
        try: () => spawnCurl(learned.prefix, input),
        catch: (cause) => dockerApiFailure(ctx)(input, cause),
      });
      if (retry.exitCode !== 0) {
        yield* Effect.fail(
          unavailable(ctx)("docker-api", `Docker API request failed with exit code ${retry.exitCode}.`, {
            method: input.method,
            path: input.path,
            stderr: retry.stderr,
          }),
        );
      }
      const retried = parseCurlHttp(retry.stdout);
      if (!Number.isInteger(retried.status)) {
        yield* Effect.fail(
          new ProviderInternalError({
            providerId: ctx.providerId,
            operation: "docker-api",
            message: "Docker API response did not include an HTTP status code.",
            details: redactString(retry.stdout),
          }),
        );
      }
      return retried;
    }),
    info: Effect.suspend(() =>
      fetchDockerInfo(makeUnixDockerApiClient(socketPath, ctx, options).request, ctx),
    ),
  };
};

export const makeNamedPipeDockerApiClient = (
  pipePath: string,
  ctx: ProviderErrorContext,
  options?: DockerApiClientOptions,
  connect?: (path: string) => Promise<SocketHttpConnection>,
): DockerApiClient => {
  const session = prefixSessionForHost(`npipe:${pipePath}`, options);
  const clientFor = (prefix: string) => makeNamedPipeTransportClient(pipePath, connect, prefix);
  return {
    stream: (input) =>
      Stream.fromAsyncIterable(
        (async function* () {
          const used = initialPrefix(session, ctx);
          yield* clientFor(used.prefix).stream(input);
        })(),
        (cause) => dockerApiFailure(ctx)(input, cause),
      ),
    request: (input) =>
      Effect.tryPromise({
        try: () => {
          const used = initialPrefix(session, ctx);
          return requestThroughClient(clientFor(used.prefix), input, session, used, ctx, clientFor);
        },
        catch: (cause) => dockerApiFailure(ctx)(input, cause),
      }),
    info: fetchDockerInfo(
      (input) =>
        Effect.tryPromise({
          try: () => {
            const used = initialPrefix(session, ctx);
            return requestThroughClient(clientFor(used.prefix), input, session, used, ctx, clientFor);
          },
          catch: (cause) => dockerApiFailure(ctx)(input, cause),
        }),
      ctx,
    ),
  };
};

export const makeHttpDockerApiClient = (
  baseUrl: string,
  ctx: ProviderErrorContext,
  options?: DockerApiClientOptions,
): DockerApiClient => {
  const session = prefixSessionForHost(baseUrl, options);
  const clientFor = (prefix: string) => makeTcpTransportClient(baseUrl, undefined, prefix);
  return {
    stream: (input) =>
      Stream.fromAsyncIterable(
        (async function* () {
          const used = initialPrefix(session, ctx);
          yield* streamHttpRequest(baseUrl, input, ctx, used.prefix);
        })(),
        (cause) => dockerApiFailure(ctx)(input, cause),
      ),
    request: (input) =>
      Effect.tryPromise({
        try: () => {
          const used = initialPrefix(session, ctx);
          return requestThroughClient(clientFor(used.prefix), input, session, used, ctx, clientFor);
        },
        catch: (cause) => dockerApiFailure(ctx)(input, cause),
      }),
    info: Effect.suspend(() => fetchDockerInfo(makeHttpDockerApiClient(baseUrl, ctx, options).request, ctx)),
  };
};

export const makeDockerApiClient = (
  dockerHost: string,
  ctx: ProviderErrorContext,
  options?: DockerApiClientOptions,
): DockerApiClient => {
  if (dockerHost.startsWith("npipe:"))
    return makeNamedPipeDockerApiClient(normalizeNamedPipePath(dockerHost), ctx, options);
  if (dockerHost.startsWith("unix://") || dockerHost.startsWith("/")) {
    const socketPath = dockerHost.startsWith("unix://") ? dockerHost.slice("unix://".length) : dockerHost;
    return makeUnixDockerApiClient(socketPath, ctx, options);
  }
  return makeHttpDockerApiClient(dockerHttpBaseUrl(dockerHost), ctx, options);
};
