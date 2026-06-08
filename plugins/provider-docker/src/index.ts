import { createConnection, isIP } from "node:net";
import { connect as createTlsConnection } from "node:tls";

import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
} from "@lando/container-runtime/plan";
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
import {
  type AppId,
  type AppPlan,
  type HostPlatform,
  PluginManifest,
  ProviderCapabilities,
  type ServicePlan,
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
  type LogOptions,
  type LogTarget,
  type ProviderError,
  RuntimeProvider,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
  type ServiceSelector,
} from "@lando/sdk/services";

export const PLUGIN_NAME = "@lando/provider-docker" as const;
export const scratchLabelsForPlan = (plan: AppPlan): Record<string, string> => {
  const scratch = plan.extensions["@lando/core/scratch"] as { readonly id?: string } | undefined;
  return scratch?.id === plan.id ? { "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": scratch.id } : {};
};

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
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
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

const unavailable = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message: withApiReason(message, details),
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
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
    message: withApiReason(message, details),
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
  if (request.stdin !== undefined && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    const secure = parsed.protocol === "https:";
    const client = makeSocketHttpClient({
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

  const response = await fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
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

export const npipeSocketPath = normalizeNamedPipePath;

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
  buildProviderCapabilities({
    bindMounts: true,
    bindMountPerformance: isVmMediatedDockerHost(platform, dockerHost) ? "slow" : "native",
    tlsCertificates: "none",
    rootless: false,
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
    networkingConfig: { EndpointsConfig: { [networkName(plan)]: {} } },
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
        .filter((endpoint) => endpoint.port !== undefined)
        .map(
          (endpoint) =>
            `      - "127.0.0.1:${endpoint.port}:${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}"`,
        )
        .join("\n");
      const networks = [
        "    networks:",
        ...networkNames(plan).flatMap((name) => {
          if (name !== sharedNetwork) return [`      ${name}:`];
          const aliases = serviceNetworkAliases(plan, service);
          return aliases.length === 0
            ? [`      ${name}:`]
            : [`      ${name}:`, "        aliases:", ...aliases.map((alias) => `          - "${alias}"`)];
        }),
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
    const sharedNetwork = landoSharedNetworkName(plan);
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
      if (sharedNetwork !== undefined) {
        const connectEffect = connectSharedNetwork(api, plan, service, name, sharedNetwork);
        if (inspected.exists && inspected.running) {
          yield* connectEffect;
        } else {
          yield* connectEffect.pipe(Effect.tapError(() => rollbackPartialApply(api, plan, touched)));
        }
      }
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
  const capabilities =
    options.dockerApi === undefined && options.dockerApiFactory === undefined
      ? Effect.succeed(dockerCapabilitiesForHost(platform, resolvedDockerHost))
      : introspectProviderCapabilities(dockerApi, platform, resolvedDockerHost);

  const resolvePlan = (target: { readonly app: AppId; readonly plan?: AppPlan }): AppPlan | undefined =>
    target.plan ?? plans.get(target.app);

  return capabilities.pipe(
    Effect.map(
      (resolvedCapabilities): RuntimeProviderShape => ({
        id: PROVIDER_ID,
        displayName: "Docker Runtime Provider",
        version: "0.0.0",
        platform,
        capabilities: resolvedCapabilities,
        isAvailable: dockerApi.info.pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
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
          const plan = resolvePlan(target);
          return plan === undefined
            ? Effect.void
            : bringDown(plan, dockerApi, { volumes: destroyOptions.volumes }).pipe(
                Effect.tap(() => Effect.sync(() => plans.delete(target.app))),
              );
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
        run: () => Effect.fail(makeUnavailable("run")),
        logs: (target, logOptions) => {
          const plan = resolvePlan(target);
          return plan === undefined
            ? Stream.fail(makeUnavailable("logs"))
            : logs(plan, target, logOptions, dockerApi);
        },
        inspect: (target) => {
          const plan = resolvePlan(target);
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
