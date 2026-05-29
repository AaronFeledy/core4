import { createConnection } from "node:net";
import { Effect, Layer, Schema, Stream } from "effect";

import {
  ProviderCapabilityError,
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceExecError,
  ServiceNotFoundError,
  ServiceStartError,
} from "@lando/sdk/errors";
import {
  type AppPlan,
  type HostPlatform,
  PluginManifest,
  ProviderCapabilities,
  type ServicePlan,
  fileSyncVolumeName,
  sameAppMountTarget,
} from "@lando/sdk/schema";
import {
  type CommandSpec,
  type ExecChunk,
  type ExecResult,
  type ExecTarget,
  type LogChunk,
  type LogOptions,
  type LogTarget,
  type ProviderError,
  RuntimeProvider,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
  type ServiceSelector,
} from "@lando/sdk/services";

export const PLUGIN_NAME = "@lando/provider-docker" as const;

const PROVIDER_ID = "docker";
const textDecoder = new TextDecoder();

const APPLY_REMEDIATION =
  "Run `lando destroy` to clean up any partial app state, then retry `lando start`. Run `lando doctor` if the failure persists.";

const REDACTED = "[REDACTED]" as const;
const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|credential|bearer|apikey|api[_-]?key|^authorization$|^auth(?:token|orization)?$/iu;
const SECRET_ENV_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|BEARER|APIKEY|API_KEY)[A-Z0-9_]*)=([^\s,;"'\]\}]+)/gu;
const redactString = (value: string): string =>
  value.replace(SECRET_ENV_PATTERN, (_, name) => `${String(name)}=${REDACTED}`);
const redactObject = (value: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactDetails(raw);
  }
  return out;
};
const redactDetails = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactDetails(item));
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (typeof value === "object") return redactObject(value as Record<string, unknown>);
  if (typeof value === "string") return redactString(value);
  return value;
};
type Bytes = Uint8Array<ArrayBufferLike>;

export interface DockerHttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
}

export interface DockerHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface DockerApiClient {
  readonly info: Effect.Effect<
    unknown,
    ProviderCapabilityError | ProviderUnavailableError | ProviderInternalError
  >;
  readonly request?: (
    request: DockerHttpRequest,
  ) => Effect.Effect<DockerHttpResponse, ProviderUnavailableError | ProviderInternalError>;
  readonly stream?: (
    request: DockerHttpRequest,
  ) => Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError>;
}

export interface ProviderLayerOptions {
  readonly dockerApi?: DockerApiClient;
  readonly dockerApiFactory?: (dockerHost: string) => DockerApiClient;
  readonly dockerHost?: string;
  readonly platform?: HostPlatform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolveDockerHostOptions {
  readonly dockerHost?: string;
  readonly platform?: HostPlatform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface EmitComposeOptions {
  readonly userDataRoot: string;
}

export interface EmitComposeResult {
  readonly path: string;
  readonly content: string;
}

interface ContainerInspect {
  readonly Id?: string;
  readonly State?: {
    readonly Running?: boolean;
    readonly Status?: string;
    readonly StartedAt?: string;
  };
}

interface ExecCreateResponse {
  readonly Id?: string;
}

interface ExecInspectResponse {
  readonly ExitCode?: number | null;
}

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const networkName = (plan: AppPlan) => `lando-${plan.slug}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");
const SHARED_CROSS_APP_NETWORK = "lando_bridge_network";

const networkNames = (plan: AppPlan): ReadonlyArray<string> =>
  Array.from(new Set([networkName(plan), SHARED_CROSS_APP_NETWORK]));

const serviceNetworkAliases = (plan: AppPlan, service: ServicePlan): ReadonlyArray<string> => [
  `${service.name}.${plan.slug}.internal`,
];

const unavailable = (operation: string, message: string, details?: unknown) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message,
    ...(details === undefined ? {} : { details }),
  });

const internal = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const serviceStartFailure = (service: ServicePlan, message: string, details?: unknown, cause?: unknown) =>
  new ServiceStartError({
    providerId: PROVIDER_ID,
    operation: "apply",
    service: service.name,
    message,
    remediation: APPLY_REMEDIATION,
    ...(details === undefined ? {} : { details: redactDetails(details) }),
    ...(cause === undefined ? {} : { cause }),
  });

const serviceExecFailure = (service: ServicePlan, message: string, details?: unknown) =>
  new ServiceExecError({
    providerId: PROVIDER_ID,
    operation: "exec",
    service: service.name,
    message,
    ...(details === undefined ? {} : { details }),
  });

const missingService = (operation: string, target: ServiceSelector) =>
  new ServiceNotFoundError({
    providerId: PROVIDER_ID,
    operation,
    service: target.service,
    message: `Service ${target.service} is not present in the app plan.`,
  });

const missingApi = (operation: string) =>
  unavailable(operation, `provider-docker ${operation} requires a Docker API client.`);

const parseJson = (
  response: DockerHttpResponse,
  operation: string,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : (JSON.parse(response.body) as unknown)),
    catch: (cause) => internal(operation, "Docker API returned malformed JSON.", response, cause),
  });

const parseInfoJson = (response: DockerHttpResponse) =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : (JSON.parse(response.body) as unknown)),
    catch: (cause) =>
      new ProviderCapabilityError({
        providerId: PROVIDER_ID,
        operation: "capabilities",
        message: "Docker API returned malformed info JSON.",
        capability: "docker-info",
        requiredValue: "valid JSON Docker info response",
        actualValue: response.body,
        cause,
      }),
  });

const request = (
  api: DockerApiClient,
  operation: string,
  input: DockerHttpRequest,
): Effect.Effect<DockerHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  api.request === undefined ? Effect.fail(missingApi(operation)) : api.request(input);

const stream = (
  api: DockerApiClient,
  operation: string,
  input: DockerHttpRequest,
): Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError> =>
  api.stream === undefined ? Stream.fail(missingApi(operation)) : api.stream(input);

const dockerApiFailure = (
  request: DockerHttpRequest,
  cause: unknown,
): ProviderUnavailableError | ProviderInternalError =>
  cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError
    ? cause
    : unavailable("docker-api", "Failed to call the Docker API.", {
        method: request.method,
        path: request.path,
        cause,
      });

const requestBody = (request: DockerHttpRequest): string | undefined =>
  request.body === undefined ? undefined : JSON.stringify(request.body);

const dockerHttpRequestText = (request: DockerHttpRequest, body: string | undefined): string => {
  const headers = [
    `${request.method} /v1.43${request.path} HTTP/1.1`,
    "Host: localhost",
    "Connection: close",
  ];
  if (body !== undefined) {
    headers.push(
      "Content-Type: application/json",
      `Content-Length: ${new TextEncoder().encode(body).length}`,
    );
  }
  return `${headers.join("\r\n")}\r\n\r\n${body ?? ""}`;
};

const headerSeparator: Bytes = new TextEncoder().encode("\r\n\r\n");

const indexOfBytes = (haystack: Bytes, needle: Bytes): number => {
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
};

const concatBytes = (chunks: ReadonlyArray<Bytes>): Bytes => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
};

interface ParsedDockerHttpHead {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyStart: Bytes;
}

const parseDockerHttpHead = (bytes: Bytes, operation: string): ParsedDockerHttpHead => {
  const marker = indexOfBytes(bytes, headerSeparator);
  if (marker === -1) {
    throw internal(operation, "Docker API response did not include HTTP headers.", textDecoder.decode(bytes));
  }
  const head = textDecoder.decode(bytes.slice(0, marker));
  const [statusLine, ...headerLines] = head.split("\r\n");
  const statusText = statusLine?.split(/\s+/u)[1];
  const status = statusText === undefined ? Number.NaN : Number.parseInt(statusText, 10);
  if (!Number.isInteger(status)) {
    throw internal(operation, "Docker API response did not include an HTTP status code.", head);
  }
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator !== -1) {
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
  }
  return { status, headers, bodyStart: bytes.slice(marker + headerSeparator.length) };
};

async function* decodeChunkedBody(chunks: AsyncIterable<Bytes>): AsyncGenerator<Bytes> {
  let buffer: Bytes = new Uint8Array(0);
  for await (const chunk of chunks) {
    buffer = concatBytes([buffer, chunk]);
    while (true) {
      const marker = indexOfBytes(buffer, new TextEncoder().encode("\r\n"));
      if (marker === -1) break;
      const size = Number.parseInt(textDecoder.decode(buffer.slice(0, marker)), 16);
      if (!Number.isInteger(size)) break;
      const chunkStart = marker + 2;
      const chunkEnd = chunkStart + size;
      if (buffer.length < chunkEnd + 2) break;
      if (size === 0) return;
      yield buffer.slice(chunkStart, chunkEnd);
      buffer = buffer.slice(chunkEnd + 2);
    }
  }
}

const chunkSeparator = new TextEncoder().encode("\r\n");

const decodeChunkedBuffer = (
  buffer: Bytes,
): { readonly chunks: ReadonlyArray<Bytes>; readonly remainder: Bytes; readonly complete: boolean } => {
  const chunks: Bytes[] = [];
  let remaining: Bytes = buffer;

  while (true) {
    const sizeEnd = indexOfBytes(remaining, chunkSeparator);
    if (sizeEnd === -1) break;

    const size = Number.parseInt(textDecoder.decode(remaining.slice(0, sizeEnd)), 16);
    if (!Number.isInteger(size)) break;

    const chunkStart = sizeEnd + chunkSeparator.length;
    const chunkEnd = chunkStart + size;
    if (remaining.length < chunkEnd + chunkSeparator.length) break;

    if (size === 0) return { chunks, remainder: new Uint8Array(0) as Bytes, complete: true };

    chunks.push(remaining.slice(chunkStart, chunkEnd));
    remaining = remaining.slice(chunkEnd + chunkSeparator.length);
  }

  return { chunks, remainder: remaining, complete: false };
};

const flushChunkedBufferAtEnd = (buffer: Bytes): ReadonlyArray<Bytes> => {
  const chunks: Bytes[] = [];
  let remaining: Bytes = buffer;

  while (true) {
    const sizeEnd = indexOfBytes(remaining, chunkSeparator);
    if (sizeEnd === -1) break;

    const size = Number.parseInt(textDecoder.decode(remaining.slice(0, sizeEnd)), 16);
    if (!Number.isInteger(size)) break;

    const chunkStart = sizeEnd + chunkSeparator.length;
    const chunkEnd = chunkStart + size;
    if (remaining.length < chunkEnd) break;

    if (size === 0) return chunks;

    chunks.push(remaining.slice(chunkStart, chunkEnd));
    if (remaining.length < chunkEnd + chunkSeparator.length) break;

    remaining = remaining.slice(chunkEnd + chunkSeparator.length);
  }

  return chunks;
};

async function* streamNamedPipeRequest(pipePath: string, request: DockerHttpRequest): AsyncGenerator<Bytes> {
  const socket = createConnection({ path: pipePath });
  const body = requestBody(request);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const initialChunks: Bytes[] = [];
  socket.write(dockerHttpRequestText(request, body));

  try {
    let parsed: ParsedDockerHttpHead | undefined;
    let chunkedBody = false;
    let bodyBuffer: Bytes = new Uint8Array(0) as Bytes;

    for await (const chunk of socket) {
      if (parsed === undefined) {
        initialChunks.push(chunk);
        const merged = concatBytes(initialChunks);
        if (indexOfBytes(merged, headerSeparator) === -1) continue;
        parsed = parseDockerHttpHead(merged, "docker-api");
        if (parsed.status < 200 || parsed.status >= 300) {
          throw unavailable(
            "docker-api",
            `Docker API stream request failed with HTTP ${parsed.status}.`,
            request,
          );
        }
        chunkedBody = parsed.headers.get("transfer-encoding")?.toLowerCase() === "chunked";
        if (chunkedBody) {
          bodyBuffer = parsed.bodyStart;
          const decoded = decodeChunkedBuffer(bodyBuffer);
          for (const bodyChunk of decoded.chunks) yield bodyChunk;
          bodyBuffer = decoded.remainder;
          if (decoded.complete) return;
        } else {
          if (parsed.bodyStart.length > 0) yield parsed.bodyStart;
        }
        continue;
      }

      if (chunkedBody) {
        bodyBuffer = concatBytes([bodyBuffer, chunk]);
        const decoded = decodeChunkedBuffer(bodyBuffer);
        for (const bodyChunk of decoded.chunks) yield bodyChunk;
        bodyBuffer = decoded.remainder;
        if (decoded.complete) return;
        continue;
      }

      yield chunk;
    }

    if (parsed === undefined) {
      throw internal("docker-api", "Docker API stream response ended before HTTP headers.", request);
    }
    if (chunkedBody && bodyBuffer.length > 0) {
      for (const bodyChunk of flushChunkedBufferAtEnd(bodyBuffer)) yield bodyChunk;
    }
  } finally {
    socket.destroy();
  }
}

const collectBytes = async (chunks: AsyncIterable<Bytes>): Promise<Bytes> => {
  const collected: Bytes[] = [];
  for await (const chunk of chunks) {
    collected.push(chunk);
  }
  return concatBytes(collected);
};

const requestNamedPipe = async (
  pipePath: string,
  request: DockerHttpRequest,
): Promise<DockerHttpResponse> => {
  const socket = createConnection({ path: pipePath });
  const body = requestBody(request);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(dockerHttpRequestText(request, body));
  try {
    const responseBytes = await collectBytes(socket);
    const parsed = parseDockerHttpHead(responseBytes, "docker-api");
    const bodyBytes =
      parsed.headers.get("transfer-encoding")?.toLowerCase() === "chunked"
        ? await collectBytes(
            decodeChunkedBody(
              (async function* () {
                yield parsed.bodyStart;
              })(),
            ),
          )
        : parsed.bodyStart;
    return { status: parsed.status, body: textDecoder.decode(bodyBytes) };
  } finally {
    socket.destroy();
  }
};

async function* streamUnixSocketRequest(
  socketPath: string,
  request: DockerHttpRequest,
): AsyncGenerator<Uint8Array> {
  const args = [
    "--silent",
    "--show-error",
    "--fail",
    "--no-buffer",
    "--unix-socket",
    socketPath,
    "--request",
    request.method,
  ];

  if (request.body !== undefined) {
    args.push("--header", "Content-Type: application/json", "--data", JSON.stringify(request.body));
  }

  args.push(`http://localhost/v1.43${request.path}`);
  const proc = Bun.spawn(["curl", ...args], { stderr: "pipe", stdout: "pipe" });
  const stderr = new Response(proc.stderr).text();

  for await (const chunk of proc.stdout) {
    yield chunk;
  }

  const [stderrText, exitCode] = await Promise.all([stderr, proc.exited]);
  if (exitCode !== 0) {
    throw unavailable("docker-api", `Docker API stream request failed with exit code ${exitCode}.`, {
      method: request.method,
      path: request.path,
      stderr: stderrText,
    });
  }
}

async function* streamHttpRequest(baseUrl: string, request: DockerHttpRequest): AsyncGenerator<Uint8Array> {
  const response = await fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    ...(request.body === undefined
      ? {}
      : { body: JSON.stringify(request.body), headers: { "Content-Type": "application/json" } }),
  });

  if (response.body === null) {
    throw unavailable("docker-api", "Docker API stream response did not include a body.", request);
  }
  if (!response.ok) {
    throw unavailable(
      "docker-api",
      `Docker API stream request failed with HTTP ${response.status}.`,
      request,
    );
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

const dockerHttpBase = (dockerHost: string): string => {
  if (dockerHost.startsWith("tcp://")) {
    return `http://${dockerHost.slice("tcp://".length)}/v1.43`;
  }
  if (dockerHost.startsWith("http://") || dockerHost.startsWith("https://")) {
    return `${dockerHost.replace(/\/+$/u, "")}/v1.43`;
  }
  return dockerHost;
};

const isUnixDockerHost = (dockerHost: string) =>
  dockerHost.startsWith("unix://") || dockerHost.startsWith("/");

const unixSocketPath = (dockerHost: string) =>
  dockerHost.startsWith("unix://") ? dockerHost.slice("unix://".length) : dockerHost;

export const isNpipeDockerHost = (dockerHost: string): boolean => dockerHost.startsWith("npipe:");

export const npipeSocketPath = (dockerHost: string): string => {
  if (!dockerHost.startsWith("npipe:")) return dockerHost;
  const pipePath = dockerHost.slice("npipe:".length);
  const dockerDesktopPipe = pipePath.match(/^\/{2,4}\.\/pipe\/(.+)$/u);
  if (dockerDesktopPipe !== null) {
    return `\\\\.\\pipe\\${(dockerDesktopPipe[1] ?? "").replaceAll("/", "\\")}`;
  }
  return pipePath;
};

const platformFromProcess = (): HostPlatform =>
  process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : "win32";

const isVmMediatedDockerHost = (platform: HostPlatform, dockerHost: string): boolean => {
  if (platform === "darwin" || platform === "win32") return true;
  const socketPath = unixSocketPath(dockerHost);
  return (
    dockerHost.startsWith("tcp://") ||
    dockerHost.startsWith("http://") ||
    dockerHost.startsWith("https://") ||
    socketPath.includes("/.docker/desktop/") ||
    socketPath.includes("/.docker/run/")
  );
};

export const dockerCapabilitiesForHost = (platform: HostPlatform, dockerHost: string): ProviderCapabilities =>
  Schema.decodeSync(ProviderCapabilities)({
    artifactBuild: false,
    artifactPull: false,
    buildSecrets: false,
    buildSsh: false,
    multiServiceApply: true,
    serviceExec: true,
    serviceLogs: true,
    serviceHealth: "lando",
    hostReachability: "emulated",
    sharedCrossAppNetwork: true,
    persistentStorage: true,
    bindMounts: true,
    bindMountPerformance: isVmMediatedDockerHost(platform, dockerHost) ? "slow" : "native",
    copyMounts: false,
    hostPortPublish: "proxy",
    routeProvider: false,
    tlsCertificates: "none",
    rootless: false,
    privilegedServices: false,
    composeSpec: "portable",
    providerExtensions: [],
  });

export const dockerCapabilitiesForPlatform = (platform: HostPlatform): ProviderCapabilities =>
  dockerCapabilitiesForHost(platform, "/var/run/docker.sock");

export const linuxDockerCapabilities = dockerCapabilitiesForHost("linux", "/var/run/docker.sock");
export const macosDockerCapabilities = dockerCapabilitiesForHost("darwin", "/var/run/docker.sock");
export const windowsDockerCapabilities = dockerCapabilitiesForHost("win32", "npipe://./pipe/docker_engine");

export const decodeProviderCapabilities = (input: unknown) =>
  Schema.decodeUnknown(ProviderCapabilities)(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderCapabilityError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: "provider-docker returned invalid ProviderCapabilities.",
          capability: "ProviderCapabilities",
          requiredValue: "@lando/sdk/schema ProviderCapabilities",
          actualValue: input,
          cause,
        }),
    ),
  );

export const introspectProviderCapabilities = (
  api: DockerApiClient,
  platform: HostPlatform = platformFromProcess(),
  dockerHost = "/var/run/docker.sock",
): Effect.Effect<ProviderCapabilities, ProviderCapabilityError | ProviderUnavailableError> =>
  api.info.pipe(
    Effect.mapError((cause) =>
      cause instanceof ProviderInternalError
        ? new ProviderCapabilityError({
            providerId: PROVIDER_ID,
            operation: "capabilities",
            message: "Docker API info inspection failed.",
            capability: "docker-info",
            requiredValue: "Docker info response",
            actualValue: undefined,
            cause,
          })
        : cause,
    ),
    Effect.map(() => dockerCapabilitiesForHost(platform, dockerHost)),
  );

const makeUnixDockerApiClient = (socketPath: string): DockerApiClient => ({
  stream: (input) =>
    Stream.fromAsyncIterable(streamUnixSocketRequest(socketPath, input), (cause) =>
      dockerApiFailure(input, cause),
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
      args.push(`http://localhost/v1.43${input.path}`);

      const { stdout, stderr, exitCode } = yield* Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["curl", ...args], { stderr: "pipe", stdout: "pipe" });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { stdout, stderr, exitCode };
        },
        catch: (cause) => dockerApiFailure(input, cause),
      });
      if (exitCode !== 0) {
        yield* Effect.fail(
          unavailable("docker-api", `Docker API request failed with exit code ${exitCode}.`, {
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
          internal("docker-api", "Docker API response did not include an HTTP status code.", stdout),
        );
      }
      return { status, body: marker === -1 ? "" : stdout.slice(0, marker) };
    }),
  info: Effect.gen(function* () {
    const response = yield* makeUnixDockerApiClient(socketPath).request?.({ method: "GET", path: "/info" }) ??
      Effect.fail(unavailable("capabilities", "Docker API request client is missing."));
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        unavailable("capabilities", `Docker info failed with HTTP ${response.status}.`, response),
      );
    }
    return yield* parseInfoJson(response);
  }),
});

const makeNamedPipeDockerApiClient = (pipePath: string): DockerApiClient => ({
  stream: (input) =>
    Stream.fromAsyncIterable(streamNamedPipeRequest(pipePath, input), (cause) =>
      dockerApiFailure(input, cause),
    ),
  request: (input) =>
    Effect.tryPromise({
      try: () => requestNamedPipe(pipePath, input),
      catch: (cause) => dockerApiFailure(input, cause),
    }),
  info: Effect.gen(function* () {
    const response = yield* makeNamedPipeDockerApiClient(pipePath).request?.({
      method: "GET",
      path: "/info",
    }) ?? Effect.fail(unavailable("capabilities", "Docker API request client is missing."));
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        unavailable("capabilities", `Docker info failed with HTTP ${response.status}.`, response),
      );
    }
    return yield* parseInfoJson(response);
  }),
});

const makeHttpDockerApiClient = (baseUrl: string): DockerApiClient => ({
  stream: (input) =>
    Stream.fromAsyncIterable(streamHttpRequest(baseUrl, input), (cause) => dockerApiFailure(input, cause)),
  request: (input) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl}${input.path}`, {
          method: input.method,
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body), headers: { "Content-Type": "application/json" } }),
        });
        return { status: response.status, body: await response.text() };
      },
      catch: (cause) => dockerApiFailure(input, cause),
    }),
  info: Effect.gen(function* () {
    const response = yield* makeHttpDockerApiClient(baseUrl).request?.({ method: "GET", path: "/info" }) ??
      Effect.fail(unavailable("capabilities", "Docker API request client is missing."));
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        unavailable("capabilities", `Docker info failed with HTTP ${response.status}.`, response),
      );
    }
    return yield* parseInfoJson(response);
  }),
});

export const makeDockerApiClient = (
  dockerHost = process.env.DOCKER_HOST ?? "/var/run/docker.sock",
): DockerApiClient => {
  if (isNpipeDockerHost(dockerHost)) return makeNamedPipeDockerApiClient(npipeSocketPath(dockerHost));
  if (isUnixDockerHost(dockerHost)) return makeUnixDockerApiClient(unixSocketPath(dockerHost));
  return makeHttpDockerApiClient(dockerHttpBase(dockerHost));
};

export const resolveDockerHost = (options: ResolveDockerHostOptions = {}): string => {
  const env = options.env ?? process.env;
  if (options.dockerHost !== undefined) return options.dockerHost;
  const platform = options.platform ?? platformFromProcess();
  if (platform === "win32" && env.LANDO_TEST_WINDOWS_DOCKER_SOCKET !== undefined) {
    return env.LANDO_TEST_WINDOWS_DOCKER_SOCKET;
  }
  if (env.LANDO_TEST_DOCKER_SOCKET !== undefined) return env.LANDO_TEST_DOCKER_SOCKET;
  if (env.DOCKER_HOST !== undefined) return env.DOCKER_HOST;
  if (platform === "win32") return "npipe://./pipe/docker_engine";
  if (platform === "linux" && env.HOME !== undefined && env.LANDO_DOCKER_DESKTOP === "1") {
    return `${env.HOME}/.docker/desktop/docker.sock`;
  }
  return "/var/run/docker.sock";
};

const serviceEnv = (service: ServicePlan) =>
  Object.entries(service.environment).map(([key, value]) => `${key}=${value}`);

const mountSuffix = (readOnly: boolean) => (readOnly ? ":ro" : "");

const normalizeCmd = (cmd: ReadonlyArray<string> | string | undefined): Array<string> | undefined => {
  if (cmd === undefined) return undefined;
  if (typeof cmd === "string") return ["sh", "-lc", cmd];
  return [...cmd];
};

const normalizeEntrypoint = (
  entrypoint: ReadonlyArray<string> | string | undefined,
): Array<string> | undefined => {
  if (entrypoint === undefined) return undefined;
  if (typeof entrypoint === "string") return [entrypoint];
  return [...entrypoint];
};

const hostConfig = (plan: AppPlan, service: ServicePlan) => {
  const portBindings = Object.fromEntries(
    service.endpoints
      .filter((endpoint) => endpoint.port !== undefined)
      .map((endpoint) => [
        `${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}`,
        [{ HostIp: "127.0.0.1", HostPort: String(endpoint.port) }],
      ]),
  );

  const appMounts =
    service.appMount === undefined
      ? []
      : [
          `${
            service.appMount.realization === "accelerated"
              ? fileSyncVolumeName(plan.name, String(service.name), "app-mount")
              : service.appMount.source
          }:${service.appMount.target}${mountSuffix(service.appMount.readOnly)}`,
        ];
  const binds = service.mounts.flatMap((mount, index) => {
    if (mount.type !== "bind") return [];
    if (sameAppMountTarget(service.appMount, mount)) return [];
    if (mount.source === undefined) {
      throw serviceStartFailure(service, "provider-docker bind mounts require a source.", { mount });
    }
    const source =
      mount.realization === "accelerated"
        ? fileSyncVolumeName(plan.name, String(service.name), `mount-${index}`)
        : mount.source;
    return [`${source}:${mount.target}${mountSuffix(mount.readOnly)}`];
  });
  const allBinds = Array.from(new Set([...appMounts, ...binds]));

  return {
    ...(Object.keys(portBindings).length > 0 ? { PortBindings: portBindings } : {}),
    ...(allBinds.length > 0 ? { Binds: allBinds } : {}),
  };
};

const createContainerBody = (plan: AppPlan, service: ServicePlan) => {
  if (service.artifact?.kind !== "ref") {
    throw serviceStartFailure(service, "provider-docker apply requires pre-built artifact references.", {
      artifact: service.artifact,
    });
  }

  return {
    Image: service.artifact.ref,
    Env: serviceEnv(service),
    Cmd: normalizeCmd(service.command),
    Entrypoint: normalizeEntrypoint(service.entrypoint),
    WorkingDir: service.workingDirectory,
    Labels: { "dev.lando.app": plan.id, "dev.lando.service": service.name },
    HostConfig: hostConfig(plan, service),
    NetworkingConfig: { EndpointsConfig: { [networkName(plan)]: {} } },
  };
};

export const renderCompose = (plan: AppPlan): string => {
  const services = Object.values(plan.services)
    .map((service) => {
      const image = service.artifact?.kind === "ref" ? service.artifact.ref : "";
      const ports = service.endpoints
        .filter((endpoint) => endpoint.port !== undefined)
        .map(
          (endpoint) =>
            `      - "127.0.0.1:${endpoint.port}:${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}"`,
        )
        .join("\n");
      const networks = [
        "    networks:",
        `      ${networkName(plan)}:`,
        `      ${SHARED_CROSS_APP_NETWORK}:`,
        "        aliases:",
        ...serviceNetworkAliases(plan, service).map((alias) => `          - "${alias}"`),
      ].join("\n");
      return [
        `  ${service.name}:`,
        `    image: "${image}"`,
        ports.length === 0 ? "" : `    ports:\n${ports}`,
        networks,
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    })
    .join("\n");
  return `version: "3.9"\nservices:\n${services}\nnetworks:\n  ${networkName(plan)}:\n    name: "${networkName(plan)}"\n  ${SHARED_CROSS_APP_NETWORK}:\n    name: "${SHARED_CROSS_APP_NETWORK}"\n    external: true\n`;
};

export const emitCompose = (
  plan: AppPlan,
  options: EmitComposeOptions,
): Effect.Effect<EmitComposeResult, ProviderInternalError> =>
  Effect.tryPromise({
    try: async () => {
      const path = `${options.userDataRoot}/${plan.slug}/compose.yml`;
      const content = renderCompose(plan);
      await Bun.write(path, content);
      return { path, content };
    },
    catch: (cause) => internal("emitCompose", "Failed to emit Docker compose file.", { app: plan.id }, cause),
  });

const ensureNetwork = (api: DockerApiClient, name: string) =>
  request(api, "apply", {
    method: "POST",
    path: "/networks/create",
    body: { Name: name, Driver: "bridge", CheckDuplicate: true },
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 201 || response.status === 200 || response.status === 409
        ? Effect.void
        : Effect.fail(
            unavailable(
              "apply.network",
              `Docker network create failed with HTTP ${response.status}.`,
              response,
            ),
          ),
    ),
  );

const inspectContainer = (api: DockerApiClient, name: string) =>
  Effect.gen(function* () {
    const response = yield* request(api, "inspect", {
      method: "GET",
      path: `/containers/${encodeURIComponent(name)}/json`,
    });
    if (response.status === 404) {
      return { exists: false, running: false };
    }
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        unavailable("inspect", `Docker inspect failed with HTTP ${response.status}.`, response),
      );
    }
    const body = yield* parseJson(response, "inspect");
    const inspect = body as ContainerInspect;
    return { exists: true, running: inspect.State?.Running === true || inspect.State?.Status === "running" };
  });

const createContainer = (api: DockerApiClient, plan: AppPlan, service: ServicePlan, name: string) =>
  Effect.try({
    try: () => createContainerBody(plan, service),
    catch: (cause) =>
      cause instanceof ServiceStartError
        ? cause
        : serviceStartFailure(service, "Failed to build Docker container create payload.", undefined, cause),
  }).pipe(
    Effect.flatMap((body) =>
      request(api, "apply", {
        method: "POST",
        path: `/containers/create?name=${encodeURIComponent(name)}`,
        body,
      }),
    ),
    Effect.flatMap((response) =>
      response.status === 201 || response.status === 409
        ? Effect.void
        : Effect.fail(
            serviceStartFailure(
              service,
              `Docker container create failed with HTTP ${response.status}.`,
              response,
            ),
          ),
    ),
  );

const startContainer = (api: DockerApiClient, service: ServicePlan, name: string) =>
  request(api, "apply", { method: "POST", path: `/containers/${encodeURIComponent(name)}/start` }).pipe(
    Effect.flatMap((response) =>
      response.status === 204 || response.status === 304
        ? Effect.void
        : Effect.fail(
            serviceStartFailure(
              service,
              `Docker container start failed with HTTP ${response.status}.`,
              response,
            ),
          ),
    ),
  );

const connectSharedNetwork = (api: DockerApiClient, plan: AppPlan, service: ServicePlan, name: string) =>
  request(api, "apply", {
    method: "POST",
    path: `/networks/${encodeURIComponent(SHARED_CROSS_APP_NETWORK)}/connect`,
    body: {
      Container: name,
      EndpointConfig: { Aliases: serviceNetworkAliases(plan, service) },
    },
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 200 ||
      response.status === 201 ||
      response.status === 204 ||
      response.status === 403 ||
      response.status === 409
        ? Effect.void
        : Effect.fail(
            serviceStartFailure(
              service,
              `Docker network connect failed with HTTP ${response.status}.`,
              response,
            ),
          ),
    ),
  );

const stopContainerSilent = (api: DockerApiClient, name: string): Effect.Effect<void> =>
  request(api, "destroy", { method: "POST", path: `/containers/${encodeURIComponent(name)}/stop` }).pipe(
    Effect.catchAll(() => Effect.void),
  );

const removeContainerSilent = (api: DockerApiClient, name: string): Effect.Effect<void> =>
  request(api, "destroy", {
    method: "DELETE",
    path: `/containers/${encodeURIComponent(name)}?force=true`,
  }).pipe(Effect.catchAll(() => Effect.void));

const removeNetworkSilent = (api: DockerApiClient, plan: AppPlan): Effect.Effect<void> =>
  request(api, "destroy", {
    method: "DELETE",
    path: `/networks/${encodeURIComponent(networkName(plan))}`,
  }).pipe(Effect.catchAll(() => Effect.void));

const removeVolumeSilent = (api: DockerApiClient, name: string): Effect.Effect<void> =>
  request(api, "destroy", { method: "DELETE", path: `/volumes/${encodeURIComponent(name)}` }).pipe(
    Effect.catchAll(() => Effect.void),
  );

const rollbackPartialApply = (
  api: DockerApiClient,
  plan: AppPlan,
  touched: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.forEach(touched, (name) => stopContainerSilent(api, name), { discard: true });
    yield* Effect.forEach(touched, (name) => removeContainerSilent(api, name), { discard: true });
    yield* removeNetworkSilent(api, plan);
  });

const bringUp = (plan: AppPlan, api: DockerApiClient, signal?: AbortSignal) =>
  Effect.gen(function* () {
    yield* Effect.forEach(networkNames(plan), (name) => ensureNetwork(api, name), { discard: true });
    const touched: string[] = [];
    let changed = false;
    for (const service of Object.values(plan.services)) {
      if (signal?.aborted === true) {
        yield* rollbackPartialApply(api, plan, touched);
        yield* Effect.fail(serviceStartFailure(service, "Docker bringUp was cancelled."));
      }
      const name = containerName(plan, service);
      touched.push(name);
      const inspected = yield* inspectContainer(api, name);
      let serviceChanged = false;
      if (!inspected.exists) {
        yield* createContainer(api, plan, service, name).pipe(
          Effect.tapError(() => rollbackPartialApply(api, plan, touched)),
        );
        serviceChanged = true;
      }
      yield* connectSharedNetwork(api, plan, service, name).pipe(
        Effect.tapError(() => rollbackPartialApply(api, plan, touched)),
      );
      if (!inspected.running) {
        yield* startContainer(api, service, name).pipe(
          Effect.tapError(() => rollbackPartialApply(api, plan, touched)),
        );
        serviceChanged = true;
      }
      changed = changed || serviceChanged;
    }
    return { changed };
  });

interface BringDownOptions {
  readonly volumes?: boolean;
}

const bringDown = (plan: AppPlan, api: DockerApiClient, options: BringDownOptions = {}) =>
  Effect.gen(function* () {
    for (const service of Object.values(plan.services).reverse()) {
      const name = containerName(plan, service);
      yield* request(api, "destroy", {
        method: "POST",
        path: `/containers/${encodeURIComponent(name)}/stop`,
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 204 || response.status === 304 || response.status === 404
            ? Effect.void
            : Effect.fail(
                unavailable(
                  "destroy.stop",
                  `Docker container stop failed with HTTP ${response.status}.`,
                  response,
                ),
              ),
        ),
      );
      yield* request(api, "destroy", {
        method: "DELETE",
        path: `/containers/${encodeURIComponent(name)}?force=true`,
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 204 || response.status === 404
            ? Effect.void
            : Effect.fail(
                unavailable(
                  "destroy.remove",
                  `Docker container remove failed with HTTP ${response.status}.`,
                  response,
                ),
              ),
        ),
      );
    }
    yield* request(api, "destroy", {
      method: "DELETE",
      path: `/networks/${encodeURIComponent(networkName(plan))}`,
    }).pipe(
      Effect.flatMap((response) =>
        response.status === 204 || response.status === 404
          ? Effect.void
          : Effect.fail(
              unavailable(
                "destroy.network",
                `Docker network remove failed with HTTP ${response.status}.`,
                response,
              ),
            ),
      ),
    );
    if (options.volumes === true) {
      for (const store of plan.stores) {
        if (store.scope === "global") continue;
        yield* removeVolumeSilent(api, store.name);
      }
    }
  });

const inspectService = (
  plan: AppPlan,
  target: ServiceSelector,
  api: DockerApiClient,
): Effect.Effect<ServiceRuntimeInfo, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Effect.fail(missingService("inspect", target));
  }
  return Effect.gen(function* () {
    const response = yield* request(api, "inspect", {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/json`,
    });
    if (response.status === 404) {
      return {
        app: plan.id,
        service: service.name,
        providerId: plan.provider,
        status: "stopped",
        state: "stopped",
        endpoints: service.endpoints,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        unavailable("inspect", `Docker inspect failed with HTTP ${response.status}.`, response),
      );
    }
    const decoded = (yield* parseJson(response, "inspect")) as ContainerInspect;
    const status =
      decoded.State?.Running === true || decoded.State?.Status === "running" ? "running" : "stopped";
    const startedAtText = decoded.State?.StartedAt;
    const startedAt =
      startedAtText === undefined || startedAtText.startsWith("0001-") ? undefined : new Date(startedAtText);
    return {
      app: plan.id,
      service: service.name,
      providerId: plan.provider,
      status,
      state: status,
      ...(typeof decoded.Id === "string" && decoded.Id.length > 0 ? { containerId: decoded.Id } : {}),
      endpoints: service.endpoints,
      ...(startedAt === undefined || Number.isNaN(startedAt.getTime()) ? {} : { lastStartedAt: startedAt }),
    };
  });
};

const createExec = (plan: AppPlan, service: ServicePlan, command: CommandSpec, api: DockerApiClient) =>
  Effect.gen(function* () {
    const response = yield* request(api, "exec", {
      method: "POST",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/exec`,
      body: {
        AttachStdout: true,
        AttachStderr: true,
        Cmd: command.command,
        Tty: false,
        ...(command.cwd === undefined ? {} : { WorkingDir: command.cwd }),
        ...(command.env === undefined
          ? {}
          : { Env: Object.entries(command.env).map(([key, value]) => `${key}=${value}`) }),
      },
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        serviceExecFailure(service, "Docker failed to create an exec session.", response),
      );
    }
    const body = yield* parseJson(response, "exec.create").pipe(
      Effect.mapError((cause) =>
        serviceExecFailure(service, "Docker exec create response was malformed.", cause),
      ),
    );
    const execId = (body as ExecCreateResponse).Id;
    if (typeof execId !== "string" || execId.length === 0) {
      return yield* Effect.fail(
        serviceExecFailure(service, "Docker exec create response did not include an exec id.", body),
      );
    }
    return execId;
  });

const inspectExec = (api: DockerApiClient, service: ServicePlan, execId: string) =>
  Effect.gen(function* () {
    const response = yield* request(api, "exec", {
      method: "GET",
      path: `/exec/${encodeURIComponent(execId)}/json`,
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        serviceExecFailure(service, "Docker failed to inspect an exec session.", response),
      );
    }
    const body = yield* parseJson(response, "exec.inspect").pipe(
      Effect.mapError((cause) =>
        serviceExecFailure(service, "Docker exec inspect response was malformed.", cause),
      ),
    );
    const exitCode = (body as ExecInspectResponse).ExitCode;
    if (typeof exitCode !== "number") {
      return yield* Effect.fail(
        serviceExecFailure(service, "Docker exec inspect response did not include an exit code.", body),
      );
    }
    return exitCode;
  });

const makeAttachDecoder = () => {
  let buffer = new Uint8Array(0);
  return (chunk: Uint8Array): ReadonlyArray<Extract<ExecChunk, { readonly kind: "stdout" | "stderr" }>> => {
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;
    const decoded: Array<Extract<ExecChunk, { readonly kind: "stdout" | "stderr" }>> = [];
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
        decoded.push({ kind: streamType === 1 ? "stdout" : "stderr", chunk: payload });
      }
    }
    return decoded;
  };
};

const execStream = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  api: DockerApiClient,
): Stream.Stream<ExecChunk, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Stream.fail(missingService("exec", target));
  }
  return Stream.fromEffect(createExec(plan, service, command, api)).pipe(
    Stream.flatMap((execId) => {
      const decodeChunk = makeAttachDecoder();
      return stream(api, "exec", {
        method: "POST",
        path: `/exec/${encodeURIComponent(execId)}/start`,
        body: { Detach: false, Tty: false },
      }).pipe(
        Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))),
        Stream.concat(
          Stream.fromEffect(inspectExec(api, service, execId).pipe(Effect.map((exitCode) => ({ exitCode })))),
        ),
      );
    }),
  );
};

const exec = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  api: DockerApiClient,
): Effect.Effect<ExecResult, ProviderError> =>
  execStream(plan, target, command, api).pipe(
    Stream.runCollect,
    Effect.map((chunks) => {
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      for (const chunk of chunks) {
        if ("exitCode" in chunk) {
          exitCode = chunk.exitCode;
        } else if (chunk.kind === "stdout") {
          stdout += textDecoder.decode(chunk.chunk);
        } else {
          stderr += textDecoder.decode(chunk.chunk);
        }
      }
      return { exitCode, stdout, stderr };
    }),
  );

const parseLogLine = (service: ServicePlan, streamName: "stdout" | "stderr", line: string): LogChunk => {
  const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/u.exec(line);
  if (match === null) {
    return { service: service.name, stream: streamName, line };
  }
  const timestamp = new Date(match[1] ?? "");
  return Number.isNaN(timestamp.getTime())
    ? { service: service.name, stream: streamName, line }
    : { service: service.name, stream: streamName, line: match[2] ?? "", timestamp };
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
    chunks: lines.filter((line) => line.length > 0).map((line) => parseLogLine(service, streamName, line)),
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

  const decodeFramed = (bytes: Uint8Array): ReadonlyArray<LogChunk> => {
    const merged = new Uint8Array(frameBuffer.length + bytes.length);
    merged.set(frameBuffer);
    merged.set(bytes, frameBuffer.length);
    frameBuffer = merged;
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
          decoded.push(parseLogLine(service, streamName, line));
        }
      }
    }

    return decoded;
  };

  return (chunk: Uint8Array): ReadonlyArray<LogChunk> => {
    if (mode === "raw") {
      return decodeRaw(chunk);
    }

    if (chunk.length === 0) {
      return [];
    }

    if (mode === "unknown" && chunk[0] !== 1 && chunk[0] !== 2) {
      frameBuffer = new Uint8Array(0);
      return decodeRaw(chunk);
    }

    return decodeFramed(chunk);
  };
};

const logs = (
  plan: AppPlan,
  target: LogTarget,
  options: Partial<LogOptions>,
  api: DockerApiClient,
): Stream.Stream<LogChunk, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Stream.fail(missingService("logs", target));
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
  return Stream.suspend(() => {
    const decodeChunk = makeLogsDecoder(service);
    return stream(api, "logs", {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/logs?${query}`,
    }).pipe(Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))));
  });
};

const makeUnavailable = (operation: string) =>
  unavailable(operation, `provider-docker does not implement ${operation} yet.`);

export const makeRuntimeProvider = (options: ProviderLayerOptions = {}) => {
  const plans = new Map<string, AppPlan>();
  const platform = options.platform ?? platformFromProcess();
  const resolvedDockerHost = resolveDockerHost({
    platform,
    ...(options.dockerHost === undefined ? {} : { dockerHost: options.dockerHost }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const dockerApi =
    options.dockerApi ?? (options.dockerApiFactory ?? makeDockerApiClient)(resolvedDockerHost);
  const capabilities = introspectProviderCapabilities(dockerApi, platform, resolvedDockerHost);

  return capabilities.pipe(
    Effect.map(
      (resolvedCapabilities): RuntimeProviderShape => ({
        id: PROVIDER_ID,
        displayName: "Docker Runtime Provider",
        version: "0.0.0",
        platform,
        capabilities: resolvedCapabilities,
        isAvailable: Effect.succeed(true),
        setup: () => Effect.void,
        getStatus: Effect.succeed({ running: true, message: "ready" }),
        getVersions: Effect.succeed({ provider: "0.0.0" }),
        buildArtifact: () => Effect.fail(makeUnavailable("buildArtifact")),
        pullArtifact: () => Effect.fail(makeUnavailable("pullArtifact")),
        removeArtifact: () => Effect.void,
        apply: (plan, applyOptions) =>
          bringUp(plan, dockerApi, applyOptions.signal).pipe(
            Effect.tap(() => Effect.sync(() => plans.set(plan.id, plan))),
          ),
        start: () => Effect.void,
        stop: () => Effect.void,
        restart: () => Effect.void,
        destroy: (target, destroyOptions) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Effect.void
            : bringDown(plan, dockerApi, { volumes: destroyOptions.volumes }).pipe(
                Effect.tap(() => Effect.sync(() => plans.delete(target.app))),
              );
        },
        exec: (target, command) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Effect.fail(makeUnavailable("exec"))
            : exec(plan, target, command, dockerApi);
        },
        execStream: (target, command) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Stream.fail(makeUnavailable("execStream"))
            : execStream(plan, target, command, dockerApi);
        },
        run: () => Effect.fail(makeUnavailable("run")),
        logs: (target, logOptions) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Stream.fail(makeUnavailable("logs"))
            : logs(plan, target, logOptions, dockerApi);
        },
        inspect: (target) => {
          const plan = plans.get(target.app);
          return plan === undefined
            ? Effect.fail(makeUnavailable("inspect"))
            : inspectService(plan, target, dockerApi);
        },
        list: (filter) =>
          Effect.forEach(Array.from(plans.values()), (plan) =>
            Effect.forEach(Object.values(plan.services), (service) =>
              inspectService(plan, { app: plan.id, service: service.name }, dockerApi),
            ),
          ).pipe(
            Effect.map((snapshots) => snapshots.flat()),
            Effect.map((snapshots) =>
              filter.app === undefined
                ? snapshots
                : snapshots.filter((snapshot) => snapshot.app === filter.app),
            ),
          ),
      }),
    ),
  );
};

export const makeProviderLayer = (options: ProviderLayerOptions = {}) =>
  Layer.effect(RuntimeProvider, makeRuntimeProvider(options));

export const provider = makeProviderLayer();

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "Reference Docker RuntimeProvider implementation.",
  enabled: true,
  contributes: { providers: [PROVIDER_ID] },
  entry: "./src/index.ts",
});
