import { createConnection, isIP } from "node:net";
import { connect as createTlsConnection } from "node:tls";

import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import { makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import { makeDockerLogFileAccess } from "@lando/container-runtime/log-file-access";
import {
  type LogFileHelperPayloads,
  logFileHelperPayloadForTargets,
} from "@lando/container-runtime/log-file-helper-payloads";
import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
} from "@lando/container-runtime/plan";
import { runServiceStartSchedule } from "@lando/container-runtime/service-start-schedule";
import {
  makeAttachDecoder as makeRuntimeAttachDecoder,
  makeLogDecoder as makeRuntimeLogDecoder,
} from "@lando/container-runtime/streams";
import {
  ContainerTransportError,
  type SocketHttpConnection,
  connectSocket,
  makeSocketHttpClient,
  normalizeNamedPipePath,
} from "@lando/container-runtime/transport";
import { Effect, Layer, Schema, type Scope, Stream } from "effect";

import {
  ProviderCapabilityError,
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceExecError,
  ServiceNotFoundError,
  ServiceStartError,
} from "@lando/sdk/errors";
import { type LogFileAccess, followLogSources, logFollowLineChunks } from "@lando/sdk/log-follow";
import { definePlugin } from "@lando/sdk/plugins";
import {
  AppId,
  type AppPlan,
  type HostPlatform,
  PluginManifest,
  ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
  hostPlatformFamily,
  landoAppNetworkName,
  landoNetworkNames,
  landoServiceNetworkAliases,
  landoSharedNetworkName,
} from "@lando/sdk/schema";
import {
  type CommandSpec,
  type ExecChunk,
  type ExecResult,
  type ExecTarget,
  type LogChunk,
  LogFileHelperAssets,
  type LogOptions,
  type LogTarget,
  PathsService,
  type ProviderError,
  RuntimeProvider,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
  type ServiceSelector,
} from "@lando/sdk/services";

import { PULL_REMEDIATION, buildImageInspectRequest, pullImage } from "./image-pull.ts";
import { makeIptablesForwardCheck } from "./iptables-forward-check.ts";
import { redactDetails, redactString } from "./redact.ts";
import { waitForExit } from "./wait-for-exit.ts";

export {
  buildImageInspectRequest,
  buildImagePullRequest,
  parseImagePullFrame,
  parseImageReference,
  pullImage,
} from "./image-pull.ts";
export type { ImagePullFrame, ParsedImageReference, PulledImage } from "./image-pull.ts";

export const PLUGIN_NAME = "@lando/provider-docker" as const;
export const scratchLabelsForPlan = (plan: AppPlan): Record<string, string> => {
  const scratch = plan.extensions["@lando/core/scratch"] as { readonly id?: string } | undefined;
  return scratch?.id === plan.id ? { "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": scratch.id } : {};
};

const PROVIDER_ID = "docker";
const textDecoder = new TextDecoder();

const APPLY_REMEDIATION =
  "Run `lando destroy` to clean up any partial app state, then retry `lando start`. Run `lando doctor` if the failure persists.";

const IMAGE_MISSING_REMEDIATION =
  "The image is not present on this Docker engine and could not be pulled. Run `lando doctor --provider=docker` to inspect the Docker provider, then retry `lando start`.";

// Docker API error responses are JSON: `{ message: "..." }`.
const apiReasonFromBody = (details: unknown): string | undefined => {
  if (typeof details !== "object" || details === null || !("body" in details)) return undefined;
  const body = (details as { body?: unknown }).body;
  if (typeof body !== "string" || body.trim().length === 0) return undefined;
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = (parsed as { message?: unknown; cause?: unknown }).message;
      const fallback = (parsed as { message?: unknown; cause?: unknown }).cause;
      if (typeof candidate === "string" && candidate.trim().length > 0) reason = candidate.trim();
      else if (typeof fallback === "string" && fallback.trim().length > 0) reason = fallback.trim();
    }
  } catch {
    return undefined;
  }
  return reason === undefined ? undefined : redactString(reason);
};

const withApiReason = (message: string, details: unknown): string => {
  const reason = apiReasonFromBody(details);
  return reason === undefined ? message : `${message} ${reason}`;
};
export interface DockerHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Uint8Array>;
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
  readonly logFileAccess?: LogFileAccess;
  readonly logFileHelperPayloads?: LogFileHelperPayloads;
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

const networkName = landoAppNetworkName;
const networkNames = landoNetworkNames;
const serviceNetworkAliases = landoServiceNetworkAliases;

const unavailable = (
  operation: string,
  message: string,
  details?: unknown,
  cause?: unknown,
  remediation?: string,
) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message: withApiReason(message, details),
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
    ...(remediation === undefined ? {} : { remediation }),
  });

const internal = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const serviceStartFailure = (
  service: ServicePlan,
  message: string,
  details?: unknown,
  cause?: unknown,
  remediation: string = APPLY_REMEDIATION,
) =>
  new ServiceStartError({
    providerId: PROVIDER_ID,
    operation: "apply",
    service: service.name,
    message: withApiReason(message, details),
    remediation,
    ...(details === undefined ? {} : { details: redactDetails(details) }),
    ...(cause === undefined ? {} : { cause }),
  });

const isMissingImageCreateResponse = (response: DockerHttpResponse): boolean =>
  response.status === 404 || /no such image/iu.test(response.body);

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

const abortEffect = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.async((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const listener = () => resume(Effect.void);
    signal.addEventListener("abort", listener, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", listener));
  });

const interruptOnAbort = <E, R>(
  self: Stream.Stream<ExecChunk, E, R>,
  signal: AbortSignal | undefined,
): Stream.Stream<ExecChunk, E, R> =>
  signal === undefined ? self : self.pipe(Stream.interruptWhen(abortEffect(signal)));

const dockerApiFailure = (
  request: DockerHttpRequest,
  cause: unknown,
): ProviderUnavailableError | ProviderInternalError => {
  if (cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError) return cause;
  if (cause instanceof ContainerTransportError) {
    return cause.kind === "parse"
      ? internal("docker-api", cause.message, cause.details, cause)
      : unavailable("docker-api", cause.message, cause.details, cause);
  }
  return unavailable("docker-api", "Failed to call the Docker API.", {
    method: request.method,
    path: request.path,
    cause,
  });
};

const makeNamedPipeTransportClient = (pipePath: string) =>
  makeSocketHttpClient({
    apiPrefix: "/v1.43",
    operation: "docker-api",
    connect: async () => {
      const socket = createConnection({ path: pipePath });
      await connectSocket(socket);
      return socket as unknown as SocketHttpConnection;
    },
  });

const makeTcpTransportClient = (baseUrl: string) => {
  const parsed = new URL(baseUrl);
  const secure = parsed.protocol === "https:";
  return makeSocketHttpClient({
    apiPrefix: parsed.pathname.replace(/\/+$/u, "") || "/v1.43",
    operation: "docker-api",
    hostHeader: parsed.host,
    connect: async () => {
      const port = parsed.port === "" ? (secure ? 443 : 80) : Number(parsed.port);
      const socket = secure
        ? createTlsConnection({
            host: parsed.hostname,
            port,
            ...(isIP(parsed.hostname) === 0 ? { servername: parsed.hostname } : {}),
            rejectUnauthorized: process.env.DOCKER_TLS_VERIFY !== "0",
          })
        : createConnection({ host: parsed.hostname, port });
      await connectSocket(socket);
      return socket as unknown as SocketHttpConnection;
    },
  });
};

async function* streamUnixSocketRequest(
  socketPath: string,
  request: DockerHttpRequest,
): AsyncGenerator<Uint8Array> {
  const client = makeSocketHttpClient({
    apiPrefix: "/v1.43",
    operation: "docker-api",
    connect: async () => {
      const socket = createConnection({ path: socketPath });
      await connectSocket(socket);
      return socket as unknown as SocketHttpConnection;
    },
  });
  yield* client.stream(request);
}

async function* streamHttpRequest(baseUrl: string, request: DockerHttpRequest): AsyncGenerator<Uint8Array> {
  const parsed = new URL(baseUrl);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const client = makeTcpTransportClient(baseUrl);
    yield* client.stream(request);
    return;
  }
  if (request.stdin !== undefined) {
    throw unavailable(
      "docker-api",
      "Docker stream transport does not support interactive stdin for this Docker host URL.",
      {
        method: request.method,
        path: request.path,
        protocol: parsed.protocol,
      },
    );
  }

  throw unavailable("docker-api", "Docker stream transport does not support this Docker host URL.", {
    method: request.method,
    path: request.path,
    protocol: parsed.protocol,
  });
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

export const npipeSocketPath = normalizeNamedPipePath;

const isVmMediatedDockerHost = (platform: HostPlatform, dockerHost: string): boolean => {
  const family = hostPlatformFamily(platform);
  if (family === "darwin" || family === "win32") return true;
  const socketPath = unixSocketPath(dockerHost);
  return (
    dockerHost.startsWith("tcp://") ||
    dockerHost.startsWith("http://") ||
    dockerHost.startsWith("https://") ||
    socketPath.includes("/.docker/desktop/") ||
    socketPath.includes("/.docker/run/")
  );
};

type HostProxyCapabilities = NonNullable<ProviderCapabilities["hostProxy"]>;
type HostProxyContainerTarget = HostProxyCapabilities["containerTargets"][number];

const hostProxyContainerTarget = (arch?: string): ReadonlyArray<HostProxyContainerTarget> => {
  if (arch === "x86_64" || arch === "x64" || arch === "amd64") {
    return [{ os: "linux", arch: "x64" }];
  }
  if (arch === "aarch64" || arch === "arm64") return [{ os: "linux", arch: "arm64" }];
  return [];
};

const hostProxyTcpHostGateway = (platform: HostPlatform): string | undefined =>
  hostPlatformFamily(platform) === "win32" ? "host.docker.internal" : undefined;

const hostProxyCapabilities = (
  platform: HostPlatform,
  containerTargets: ReadonlyArray<HostProxyContainerTarget>,
): HostProxyCapabilities | undefined => {
  const tcpHostGateway = hostProxyTcpHostGateway(platform);
  if (containerTargets.length === 0 && tcpHostGateway === undefined) return undefined;
  return {
    containerTargets,
    ...(tcpHostGateway === undefined ? {} : { tcpHostGateway }),
  };
};

const dockerInfoArchitecture = (info: unknown): string | undefined => {
  if (typeof info !== "object" || info === null) return undefined;
  if ("Architecture" in info && typeof info.Architecture === "string") return info.Architecture;
  return undefined;
};

export const dockerCapabilitiesForHost = (
  platform: HostPlatform,
  dockerHost: string,
  containerTargets: ReadonlyArray<HostProxyContainerTarget> = [],
): ProviderCapabilities =>
  buildProviderCapabilities({
    bindMounts: true,
    artifactBuild: true,
    artifactPull: true,
    bindMountPerformance: isVmMediatedDockerHost(platform, dockerHost) ? "slow" : "native",
    volumeSnapshot: "copy",
    serviceFileCopy: "native",
    artifactExport: true,
    artifactImport: true,
    ephemeralMounts: true,
    tlsCertificates: "none",
    rootless: false,
    architectureEmulation: platform === "darwin" || platform === "win32",
    composeSpec: "native",
    composeServiceFields: { supported: ["labels"] },
    providerExtensions: [],
    hostProxy: hostProxyCapabilities(platform, containerTargets),
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
  platform: HostPlatform,
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
    Effect.map((info) => {
      const engineArch = dockerInfoArchitecture(info);
      return dockerCapabilitiesForHost(platform, dockerHost, hostProxyContainerTarget(engineArch));
    }),
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
      for (const [key, value] of Object.entries(input.headers ?? {})) {
        args.push("--header", `${key}: ${value}`);
      }
      if (input.stdin !== undefined) {
        args.push("--data-binary", "@-");
      }
      args.push(`http://localhost/v1.43${input.path}`);

      const { stdout, stderr, exitCode } = yield* Effect.tryPromise({
        try: async () => {
          const payload = await collectRequestStdin(input.stdin);
          const proc = Bun.spawn(["curl", ...args], {
            stderr: "pipe",
            stdin: payload === undefined ? "ignore" : "pipe",
            stdout: "pipe",
          });
          writeStdinPayload(proc.stdin as WritableStdinSink | null | undefined, payload);
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

const makeNamedPipeDockerApiClient = (pipePath: string): DockerApiClient => {
  const client = makeNamedPipeTransportClient(pipePath);
  return {
    stream: (input) =>
      Stream.fromAsyncIterable(client.stream(input), (cause) => dockerApiFailure(input, cause)),
    request: (input) =>
      Effect.tryPromise({
        try: () => client.request(input),
        catch: (cause) => dockerApiFailure(input, cause),
      }),
    info: Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => client.request({ method: "GET", path: "/info" }),
        catch: (cause) => dockerApiFailure({ method: "GET", path: "/info" }, cause),
      });
      if (response.status < 200 || response.status >= 300) {
        yield* Effect.fail(
          unavailable("capabilities", `Docker info failed with HTTP ${response.status}.`, response),
        );
      }
      return yield* parseInfoJson(response);
    }),
  };
};

const makeHttpDockerApiClient = (baseUrl: string): DockerApiClient => ({
  stream: (input) =>
    Stream.fromAsyncIterable(streamHttpRequest(baseUrl, input), (cause) => dockerApiFailure(input, cause)),
  request: (input) =>
    Effect.tryPromise({
      try: () => makeTcpTransportClient(baseUrl).request(input),
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
  if (options.platform === undefined) {
    throw unavailable("select", "provider-docker host resolution requires the resolved host platform.");
  }
  const family = hostPlatformFamily(options.platform);
  if (family === "win32" && env.LANDO_TEST_WINDOWS_DOCKER_SOCKET !== undefined) {
    return env.LANDO_TEST_WINDOWS_DOCKER_SOCKET;
  }
  if (env.LANDO_TEST_DOCKER_SOCKET !== undefined) return env.LANDO_TEST_DOCKER_SOCKET;
  if (env.DOCKER_HOST !== undefined) return env.DOCKER_HOST;
  if (family === "win32") return "npipe://./pipe/docker_engine";
  if (family === "linux" && env.HOME !== undefined && env.LANDO_DOCKER_DESKTOP === "1") {
    return `${env.HOME}/.docker/desktop/docker.sock`;
  }
  return "/var/run/docker.sock";
};

const hostConfig = (plan: AppPlan, service: ServicePlan) =>
  containerHostConfigFragment(plan, service, {
    onMissingBindMountSource: (mount) => {
      throw serviceStartFailure(service, "provider-docker bind mounts require a source.", { mount });
    },
  });

const createContainerBody = (plan: AppPlan, service: ServicePlan) =>
  containerCreateBodyFragment(plan, service, {
    labels: commonContainerLabels(plan, service, scratchLabelsForPlan(plan)),
    hostConfig: hostConfig(plan, service),
    networkingConfig: { EndpointsConfig: { [networkName(plan)]: { Aliases: [service.name] } } },
    onMissingArtifact: (artifact) => {
      throw serviceStartFailure(service, "provider-docker apply requires pre-built artifact references.", {
        artifact,
      });
    },
  });

export const renderCompose = (plan: AppPlan): string => {
  const sharedNetwork = landoSharedNetworkName(plan);
  const services = Object.values(plan.services)
    .map((service) => {
      const image = service.artifact?.kind === "ref" ? service.artifact.ref : "";
      const ports = service.endpoints
        .flatMap((endpoint) => (endpoint._tag === "published" ? [endpoint] : []))
        .map((endpoint) => {
          const bindAddress = endpoint.publication.bindAddress ?? "127.0.0.1";
          const hostPort = endpoint.publication.hostPort ?? "";
          return `      - "${bindAddress}:${hostPort}:${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}"`;
        })
        .join("\n");
      const expose = service.endpoints
        .flatMap((endpoint) =>
          endpoint._tag === "internal" && endpoint.protocol !== "unix"
            ? [`      - "${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}"`]
            : [],
        )
        .join("\n");
      const networks = [
        "    networks:",
        ...networkNames(plan).flatMap((name) => {
          const aliases = name === sharedNetwork ? serviceNetworkAliases(plan, service) : [service.name];
          return aliases.length === 0
            ? [`      ${name}:`]
            : [`      ${name}:`, "        aliases:", ...aliases.map((alias) => `          - "${alias}"`)];
        }),
      ].join("\n");
      return [
        `  ${service.name}:`,
        `    image: "${image}"`,
        ports.length === 0 ? "" : `    ports:\n${ports}`,
        expose.length === 0 ? "" : `    expose:\n${expose}`,
        networks,
      ]
        .filter((line) => line.length > 0)
        .join("\n");
    })
    .join("\n");
  const networks = networkNames(plan)
    .map((name) => {
      if (name === sharedNetwork) return `  ${name}:\n    name: "${name}"\n    external: true`;
      return `  ${name}:\n    name: "${name}"`;
    })
    .join("\n");
  return `version: "3.9"\nservices:\n${services}\nnetworks:\n${networks}\n`;
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

const volumeLabels = (plan: AppPlan, store: AppPlan["stores"][number]): Readonly<Record<string, string>> => ({
  "dev.lando.app": plan.id,
  "dev.lando.store": store.name,
  "dev.lando.scope": store.scope,
  ...(store.kind === "cache" ? { "dev.lando.storage-kind": "cache" } : {}),
});

const ensureVolume = (api: DockerApiClient, plan: AppPlan, store: AppPlan["stores"][number]) =>
  request(api, "apply", {
    method: "POST",
    path: "/volumes/create",
    body: {
      Name: store.name,
      Labels: volumeLabels(plan, store),
    },
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 201 || response.status === 200 || response.status === 409
        ? Effect.void
        : Effect.fail(
            unavailable(
              "apply.volume",
              `Docker volume create failed with HTTP ${response.status}.`,
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

const ensureImagePresent = (api: DockerApiClient, imageRef: string) =>
  Effect.gen(function* () {
    const inspectResponse = yield* request(api, "apply", buildImageInspectRequest(imageRef));
    if (inspectResponse.status === 200) return;
    if (inspectResponse.status === 404) {
      yield* pullImage(api, imageRef);
      return;
    }
    yield* Effect.fail(
      unavailable(
        "apply",
        `Docker image inspect failed with HTTP ${inspectResponse.status}.`,
        inspectResponse,
        undefined,
        PULL_REMEDIATION,
      ),
    );
  });

const createContainer = (api: DockerApiClient, plan: AppPlan, service: ServicePlan, name: string) =>
  Effect.gen(function* () {
    if (service.artifact?.kind === "ref") {
      yield* ensureImagePresent(api, service.artifact.ref);
    }
    const body = yield* Effect.try({
      try: () => createContainerBody(plan, service),
      catch: (cause) =>
        cause instanceof ServiceStartError
          ? cause
          : serviceStartFailure(
              service,
              "Failed to build Docker container create payload.",
              undefined,
              cause,
            ),
    });
    const response = yield* request(api, "apply", {
      method: "POST",
      path: `/containers/create?name=${encodeURIComponent(name)}`,
      body,
    });
    if (response.status === 201 || response.status === 409) return;
    const missingImage = isMissingImageCreateResponse(response);
    yield* Effect.fail(
      serviceStartFailure(
        service,
        `Docker container create failed with HTTP ${response.status}.`,
        response,
        undefined,
        missingImage ? IMAGE_MISSING_REMEDIATION : APPLY_REMEDIATION,
      ),
    );
  });

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

const isAlreadyConnectedResponse = (response: DockerHttpResponse) =>
  response.status === 403 && /already\s+(exists|connected)|endpoint.*exists|same name/iu.test(response.body);

const connectSharedNetwork = (
  api: DockerApiClient,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
  sharedNetwork: string,
) =>
  request(api, "apply", {
    method: "POST",
    path: `/networks/${encodeURIComponent(sharedNetwork)}/connect`,
    body: {
      Container: name,
      EndpointConfig: { Aliases: serviceNetworkAliases(plan, service) },
    },
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 200 ||
      response.status === 201 ||
      response.status === 204 ||
      response.status === 409 ||
      isAlreadyConnectedResponse(response)
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

interface DiscoveredContainer {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: string;
  readonly startedAt?: string;
}

const discoverContainers = (api: DockerApiClient, labelFilter?: string) =>
  Effect.gen(function* () {
    const filters = labelFilter === undefined ? {} : { label: [labelFilter] };
    const params = new URLSearchParams({
      all: "true",
      filters: JSON.stringify(filters),
    });

    const response = yield* request(api, "list", {
      method: "GET",
      path: `/containers/json?${params}` as `/${string}`,
    });

    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        unavailable("list", `Docker container list failed with HTTP ${response.status}.`, response),
      );
    }

    const body = yield* parseJson(response, "list");
    const containers = Array.isArray(body) ? body : [];

    return containers
      .map((container: unknown): DiscoveredContainer | undefined => {
        if (typeof container !== "object" || container === null) return undefined;
        const obj = container as {
          Id?: unknown;
          Names?: unknown;
          Labels?: unknown;
          State?: unknown;
          Status?: unknown;
        };

        if (typeof obj.Id !== "string" || !Array.isArray(obj.Names)) return undefined;
        const name = obj.Names[0];
        if (typeof name !== "string") return undefined;

        const labels =
          typeof obj.Labels === "object" && obj.Labels !== null
            ? (obj.Labels as Record<string, unknown>)
            : {};

        // In /containers/json, State is a string like "running" or "exited"
        const state = typeof obj.State === "string" ? obj.State : "unknown";

        // Status contains more info like "Up 5 minutes"
        const status = typeof obj.Status === "string" ? obj.Status : undefined;

        return {
          id: obj.Id,
          name: name.startsWith("/") ? name.slice(1) : name,
          labels: Object.fromEntries(
            Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          ),
          state,
          ...(status === undefined ? {} : { startedAt: status }),
        };
      })
      .filter((container): container is DiscoveredContainer => container !== undefined);
  });

interface TouchedContainer {
  readonly name: string;
  readonly created: boolean;
  readonly startedExisting: boolean;
}

const cleanupTouchedContainers = (
  api: DockerApiClient,
  touched: ReadonlyArray<TouchedContainer>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      touched.filter((container) => container.created || container.startedExisting),
      (container) => stopContainerSilent(api, container.name),
      { discard: true },
    );
    yield* Effect.forEach(
      touched.filter((container) => container.created),
      (container) => removeContainerSilent(api, container.name),
      { discard: true },
    );
  });

const rollbackPartialApply = (
  api: DockerApiClient,
  plan: AppPlan,
  touched: ReadonlyArray<TouchedContainer>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* cleanupTouchedContainers(api, touched);
    yield* removeNetworkSilent(api, plan);
  });

const bringUp = (plan: AppPlan, api: DockerApiClient, signal?: AbortSignal) =>
  Effect.gen(function* () {
    yield* Effect.forEach(networkNames(plan), (name) => ensureNetwork(api, name), { discard: true });
    yield* Effect.forEach(plan.stores, (store) => ensureVolume(api, plan, store), { discard: true });
    const sharedNetwork = landoSharedNetworkName(plan);
    const touched: TouchedContainer[] = [];
    const schedule = yield* runServiceStartSchedule(plan, {
      startService: (service) =>
        Effect.gen(function* () {
          if (signal?.aborted === true) {
            return yield* Effect.interrupt;
          }
          const name = containerName(plan, service);
          const inspected = yield* inspectContainer(api, name);
          touched.push({
            name,
            created: !inspected.exists,
            startedExisting: inspected.exists && !inspected.running,
          });
          let serviceChanged = false;
          if (!inspected.exists) {
            yield* createContainer(api, plan, service, name);
            serviceChanged = true;
          }
          if (sharedNetwork !== undefined) {
            yield* connectSharedNetwork(api, plan, service, name, sharedNetwork);
          }
          if (!inspected.running) {
            yield* startContainer(api, service, name);
            serviceChanged = true;
          }
          return { changed: serviceChanged };
        }).pipe(
          Effect.catchAll((error) => (signal?.aborted === true ? Effect.interrupt : Effect.fail(error))),
        ),
      cleanupOptionalStartFailure: (service) =>
        Effect.gen(function* () {
          const name = containerName(plan, service);
          const index = touched.findIndex((container) => container.name === name);
          const container = touched[index];
          if (container === undefined) return;
          yield* cleanupTouchedContainers(api, [container]);
          touched.splice(index, 1);
        }),
      execHealthcheck: (service, command) =>
        exec(
          plan,
          { app: plan.id, service: service.name },
          { command, ...(signal === undefined ? {} : { signal }) },
          api,
        ).pipe(Effect.map(({ exitCode }) => ({ exitCode }))),
      waitForExit: (service) =>
        waitForExit(
          plan,
          { app: plan.id, service: service.name },
          {
            dockerApi: api,
            ...(signal === undefined ? {} : { signal }),
          },
        ),
    }).pipe(
      Effect.tapError(() => rollbackPartialApply(api, plan, touched)),
      Effect.onInterrupt(() => rollbackPartialApply(api, plan, touched)),
    );
    if (schedule._tag === "Cycle") {
      yield* rollbackPartialApply(api, plan, touched);
      return yield* Effect.fail(
        internal("bringUp.schedule", "Docker bringUp dependency schedule contains a cycle.", {
          edges: schedule.edges,
        }),
      );
    }
    const [blocked] = schedule.blocked;
    if (blocked !== undefined) {
      yield* rollbackPartialApply(api, plan, touched);
      const service = plan.services[ServiceName.make(blocked.service)];
      if (service === undefined) {
        return yield* Effect.fail(
          internal("bringUp.schedule", "Docker bringUp schedule returned an unknown blocked service.", {
            service: blocked.service,
            unmetGate: blocked.unmetGate,
          }),
        );
      }
      return yield* Effect.fail(
        serviceStartFailure(
          service,
          `Service ${blocked.service} could not start because dependency gate ${blocked.unmetGate} was not satisfied.`,
        ),
      );
    }
    return { changed: schedule.changed };
  });

interface BringDownOptions {
  readonly volumes?: boolean;
  readonly purgeCaches?: boolean;
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
    if (options.volumes === true || options.purgeCaches === true) {
      for (const store of plan.stores) {
        if (store.kind === "cache") {
          if (options.purgeCaches !== true) continue;
        } else if (store.scope === "global" || options.volumes !== true) {
          continue;
        }
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
        AttachStdin: command.stdin === "inherit",
        Cmd: command.command,
        Tty: command.tty === true,
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

const resizeExec = (
  api: DockerApiClient,
  service: ServicePlan,
  execId: string,
  size: { readonly columns: number; readonly rows: number },
): Effect.Effect<void, ProviderError> =>
  Effect.gen(function* () {
    const params = new URLSearchParams({ h: String(size.rows), w: String(size.columns) });
    const response = yield* request(api, "exec", {
      method: "POST",
      path: `/exec/${encodeURIComponent(execId)}/resize?${params.toString()}` as `/${string}`,
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        serviceExecFailure(service, "Docker failed to resize an exec session.", response),
      );
    }
  });

const execStream = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  api: DockerApiClient,
): Stream.Stream<ExecChunk, ProviderError, Scope.Scope> => {
  const service = plan.services[target.service];
  if (service === undefined) {
    return Stream.fail(missingService("exec", target));
  }
  return Stream.fromEffect(createExec(plan, service, command, api)).pipe(
    Stream.flatMap((execId) => {
      const decodeChunk = makeRuntimeAttachDecoder();
      const resizeEvents = command.terminalResize ?? Stream.empty;
      const rawStart = stream(api, "exec", {
        method: "POST",
        path: `/exec/${encodeURIComponent(execId)}/start`,
        ...(command.signal === undefined ? {} : { signal: command.signal }),
        ...(command.stdinStream === undefined ? {} : { stdin: command.stdinStream }),
        body: { Detach: false, Tty: command.tty === true },
      });
      const start = (
        command.tty === true
          ? rawStart.pipe(Stream.map((chunk): ExecChunk => ({ kind: "stdout", chunk })))
          : rawStart.pipe(
              Stream.flatMap((chunk) =>
                Stream.fromIterable(
                  decodeChunk(chunk).map((frame) => ({ kind: frame.stream, chunk: frame.payload })),
                ),
              ),
            )
      ).pipe(
        Stream.concat(
          Stream.fromEffect(inspectExec(api, service, execId).pipe(Effect.map((exitCode) => ({ exitCode })))),
        ),
      );

      return Stream.fromEffect(
        Effect.gen(function* () {
          if (command.terminalSize !== undefined)
            yield* resizeExec(api, service, execId, command.terminalSize);
          yield* resizeEvents.pipe(
            Stream.runForEach((size) => resizeExec(api, service, execId, size)),
            Effect.forkScoped,
          );
        }),
      ).pipe(Stream.flatMap(() => interruptOnAbort(start, command.signal)));
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
    Effect.scoped,
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

const makeLogsDecoder = (service: ServicePlan) =>
  makeRuntimeLogDecoder({ parseLine: (streamName, line) => parseLogLine(service, streamName, line) });

const fileSourceSince = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? undefined : Math.floor(timestamp / 1000);
};

interface LogsRuntime {
  readonly api: DockerApiClient;
  readonly logFileAccess?: LogFileAccess;
}

const logs = (
  plan: AppPlan,
  target: LogTarget,
  options: Partial<LogOptions>,
  runtime: LogsRuntime,
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
  if (options.since !== undefined) {
    query.set("since", options.since);
  }
  const logSources = options.sources ?? service.logSources ?? [];
  const logFileAccess = runtime.logFileAccess;
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
    const consoleStream = stream(runtime.api, "logs", {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/logs?${query}`,
    }).pipe(Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))));

    return Stream.merge(consoleStream, fileStream);
  });
};

const logsWithoutPlan = (
  containerNameOrId: string,
  serviceName: ServiceName,
  _target: LogTarget,
  options: Partial<LogOptions>,
  runtime: LogsRuntime,
): Stream.Stream<LogChunk, ProviderError> => {
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

  return Stream.suspend(() => {
    const decodeChunk = makeRuntimeLogDecoder({
      parseLine: (streamName, line) => parseLogLine({ name: serviceName } as ServicePlan, streamName, line),
    });
    const consoleStream = stream(runtime.api, "logs", {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerNameOrId)}/logs?${query}`,
    }).pipe(Stream.flatMap((chunk) => Stream.fromIterable(decodeChunk(chunk))));

    return consoleStream;
  });
};

const makeUnavailable = (operation: string) =>
  unavailable(operation, `provider-docker does not implement ${operation} yet.`);

export const makeRuntimeProvider = (options: ProviderLayerOptions = {}) => {
  const plans = new Map<string, AppPlan>();
  if (options.platform === undefined) {
    return Effect.fail(
      unavailable("select", "provider-docker construction requires the resolved host platform."),
    );
  }
  const platform = options.platform;
  const resolvedDockerHost = resolveDockerHost({
    platform,
    ...(options.dockerHost === undefined ? {} : { dockerHost: options.dockerHost }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const dockerApi =
    options.dockerApi ?? (options.dockerApiFactory ?? makeDockerApiClient)(resolvedDockerHost);
  const defaultFactoryConstruction =
    options.dockerApi === undefined && options.dockerApiFactory === undefined;
  const capabilities = introspectProviderCapabilities(dockerApi, platform, resolvedDockerHost).pipe(
    Effect.catchAll((failure) =>
      defaultFactoryConstruction
        ? Effect.succeed(dockerCapabilitiesForHost(platform, resolvedDockerHost))
        : Effect.fail(failure),
    ),
  );
  const runtimeCapabilities = capabilities.pipe(
    Effect.map((resolved) => ({
      capabilities: {
        ...resolved,
        serviceLogSources:
          (options.logFileAccess !== undefined ||
            logFileHelperPayloadForTargets(
              options.logFileHelperPayloads,
              resolved.hostProxy?.containerTargets,
            ) !== undefined) &&
          resolved.serviceLogSources,
      },
      logFileHelperPayload: logFileHelperPayloadForTargets(
        options.logFileHelperPayloads,
        resolved.hostProxy?.containerTargets,
      ),
    })),
  );
  const dataPlane = makeProviderDataPlane({
    providerId: PROVIDER_ID,
    api: dockerApi,
    snapshotMode: "copy",
    redactDetails,
  });

  const resolvePlan = (target: { readonly app: AppId; readonly plan?: AppPlan }): AppPlan | undefined =>
    target.plan ?? plans.get(target.app);

  return runtimeCapabilities.pipe(
    Effect.map(
      ({ capabilities: resolvedCapabilities, logFileHelperPayload }): RuntimeProviderShape => ({
        id: PROVIDER_ID,
        displayName: "Docker Runtime Provider",
        version: "0.0.0",
        platform,
        capabilities: resolvedCapabilities,
        isAvailable: dockerApi.info.pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
        planSetup: () => Effect.succeed({ providerId: ProviderId.make(PROVIDER_ID), changes: [] }),
        setup: () => Effect.void,
        getStatus: Effect.succeed({ running: true, message: "ready" }),
        getVersions: Effect.succeed({ provider: "0.0.0" }),
        buildArtifact: (spec) => buildContainerArtifact(spec, { providerId: PROVIDER_ID, api: dockerApi }),
        pullArtifact: (spec) =>
          pullImage(dockerApi, spec.ref).pipe(
            Effect.map((result) => ({
              providerId: ProviderId.make(PROVIDER_ID),
              ref: result.ref,
              ...(result.digest === undefined ? {} : { digest: result.digest }),
            })),
          ),
        removeArtifact: () => Effect.void,
        apply: (plan, applyOptions) =>
          bringUp(plan, dockerApi, applyOptions.signal).pipe(
            Effect.tap(() => Effect.sync(() => plans.set(plan.id, plan))),
          ),
        start: () => Effect.void,
        stop: () => Effect.void,
        restart: () => Effect.void,
        waitForExit: (target, options) => {
          const plan = resolvePlan(target);
          return plan === undefined
            ? Effect.fail(makeUnavailable("waitForExit"))
            : waitForExit(plan, target, {
                dockerApi,
                ...(options?.signal === undefined ? {} : { signal: options.signal }),
              });
        },
        destroy: (target, destroyOptions) => {
          const plan = resolvePlan(target);
          return plan === undefined
            ? Effect.void
            : bringDown(plan, dockerApi, {
                volumes: destroyOptions.volumes,
                ...(destroyOptions.purgeCaches === undefined
                  ? {}
                  : { purgeCaches: destroyOptions.purgeCaches }),
              }).pipe(Effect.tap(() => Effect.sync(() => plans.delete(target.app))));
        },
        exec: (target, command) => {
          const plan = resolvePlan(target);
          return plan === undefined
            ? Effect.fail(makeUnavailable("exec"))
            : exec(plan, target, command, dockerApi);
        },
        execStream: (target, command) => {
          const plan = resolvePlan(target);
          return plan === undefined
            ? Stream.fail(makeUnavailable("execStream"))
            : execStream(plan, target, command, dockerApi);
        },
        run: dataPlane.run,
        runStream: dataPlane.runStream,
        logs: (target, logOptions) => {
          const plan = resolvePlan(target);
          if (plan !== undefined) {
            const service = plan.services[target.service];
            const logFileAccess =
              options.logFileAccess ??
              (service === undefined || logFileHelperPayload === undefined
                ? undefined
                : makeDockerLogFileAccess({
                    providerId: PROVIDER_ID,
                    api: dockerApi,
                    container: containerName(plan, service),
                    helperPayload: logFileHelperPayload,
                  }));
            return logs(plan, target, logOptions, {
              api: dockerApi,
              ...(logFileAccess === undefined ? {} : { logFileAccess }),
            });
          }

          // Plan not available - discover container by labels
          return Stream.fromEffect(
            discoverContainers(dockerApi, "dev.lando.app").pipe(
              Effect.flatMap((containers) => {
                const container = containers.find(
                  (c) =>
                    c.labels["dev.lando.app"] === target.app &&
                    c.labels["dev.lando.service"] === target.service,
                );
                if (container === undefined) {
                  return Effect.fail(
                    unavailable(
                      "logs",
                      `Container for app ${target.app} service ${target.service} not found.`,
                    ),
                  );
                }
                return Effect.succeed(container);
              }),
            ),
          ).pipe(
            Stream.flatMap((container) =>
              logsWithoutPlan(container.name, target.service, target, logOptions, { api: dockerApi }),
            ),
          );
        },
        inspect: (target) => {
          const plan = resolvePlan(target);
          return plan === undefined
            ? Effect.fail(makeUnavailable("inspect"))
            : inspectService(plan, target, dockerApi);
        },
        list: (filter) =>
          discoverContainers(dockerApi, "dev.lando.app").pipe(
            Effect.flatMap((containers) =>
              Effect.forEach(
                containers.filter((container) => {
                  const appId = container.labels["dev.lando.app"];
                  return (
                    appId !== undefined &&
                    (filter.app === undefined || appId === filter.app) &&
                    container.labels["dev.lando.scratch"] !== "TRUE"
                  );
                }),
                (container) =>
                  Effect.gen(function* () {
                    const appId = container.labels["dev.lando.app"] ?? "";
                    const serviceName = container.labels["dev.lando.service"] ?? "";
                    const isRunning = container.state === "running";
                    const status = isRunning ? "running" : "stopped";

                    // Inspect container to get endpoints
                    const inspectResponse = yield* request(dockerApi, "list", {
                      method: "GET",
                      path: `/containers/${encodeURIComponent(container.name)}/json`,
                    });

                    let endpoints: ServiceRuntimeInfo["endpoints"] = [];
                    if (inspectResponse.status >= 200 && inspectResponse.status < 300) {
                      const inspectBody = yield* parseJson(inspectResponse, "list");
                      if (
                        typeof inspectBody === "object" &&
                        inspectBody !== null &&
                        "NetworkSettings" in inspectBody
                      ) {
                        const networkSettings = inspectBody.NetworkSettings as {
                          Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
                        };
                        const ports = networkSettings.Ports ?? {};
                        endpoints = Object.entries(ports)
                          .flatMap(([containerPort, bindings]) => {
                            if (bindings === null || bindings === undefined) return [];
                            return bindings.map((binding) => {
                              const [portNum, protocol] = containerPort.split("/");
                              return {
                                _tag: "published" as const,
                                port: Number.parseInt(portNum ?? "0", 10),
                                protocol: (protocol === "udp" ? "udp" : "http") as "http" | "udp",
                                name: containerPort,
                                publication: {
                                  bindAddress: binding.HostIp ?? "0.0.0.0",
                                  hostPort: Number.parseInt(binding.HostPort ?? "0", 10),
                                },
                              };
                            });
                          })
                          .filter((endpoint) => endpoint.port > 0 && endpoint.publication.hostPort > 0);
                      }
                    }

                    return {
                      app: AppId.make(appId),
                      service: ServiceName.make(serviceName),
                      providerId: ProviderId.make(PROVIDER_ID),
                      status,
                      state: status,
                      containerId: container.id,
                      endpoints,
                      ...(container.startedAt === undefined
                        ? {}
                        : { lastStartedAt: new Date(container.startedAt) }),
                    };
                  }),
              ),
            ),
          ),
        snapshotVolume: dataPlane.snapshotVolume,
        restoreVolume: dataPlane.restoreVolume,
        listVolumes: dataPlane.listVolumes,
        removeVolume: dataPlane.removeVolume,
        copyToService: (target, spec) => {
          const plan = resolvePlan(target);
          return dataPlane.copyToService(plan === undefined ? target : { ...target, plan }, spec);
        },
        copyFromService: (target, spec) => {
          const plan = resolvePlan(target);
          return dataPlane.copyFromService(plan === undefined ? target : { ...target, plan }, spec);
        },
        exportArtifact: dataPlane.exportArtifact,
        importArtifact: dataPlane.importArtifact,
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
  requires: { "@lando/core": "^4.0.0" },
  description: "Reference Docker RuntimeProvider implementation.",
  enabled: true,
  contributes: { providers: [PROVIDER_ID] },
  entry: "./src/index.ts",
});

const runtimeProviderId = ProviderId.make(PROVIDER_ID);

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  runtimeProviders: new Map([
    [
      runtimeProviderId,
      {
        id: runtimeProviderId,
        make: () =>
          Effect.gen(function* () {
            const paths = yield* PathsService;
            const assets = yield* LogFileHelperAssets;
            const logFileHelperPayloads = yield* assets.payloads;
            return yield* makeRuntimeProvider({ platform: paths.platform, logFileHelperPayloads });
          }),
      },
    ],
  ]),
  doctorChecks: [makeIptablesForwardCheck()],
});
