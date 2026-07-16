import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import { Effect, Schema, type Stream } from "effect";

import { ProviderCapabilityError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type HostPlatform, ProviderCapabilities } from "@lando/sdk/schema";

import {
  isNamedPipeEndpoint,
  makeNamedPipePodmanApiClient,
  streamPodmanApiRequest,
} from "./named-pipe-api.ts";
import { redactDetails } from "./redact.ts";

const PROVIDER_ID = "lando";

const TRANSPORT_REMEDIATION =
  "Run `lando doctor` to inspect the Lando runtime, then retry the failing command. Run `lando setup` if the runtime is not installed or healthy.";

const bindMountPerformanceForPlatform = (
  platform: HostPlatform,
): ProviderCapabilities["bindMountPerformance"] => {
  if (platform === "linux") return "native";
  if (platform === "darwin") return "slow";
  if (platform === "win32") return "slow";
  return "none";
};

type HostProxyCapabilities = NonNullable<ProviderCapabilities["hostProxy"]>;
type HostProxyContainerTarget = HostProxyCapabilities["containerTargets"][number];

const hostProxyTcpHostGateway = (platform: HostPlatform): string | undefined =>
  platform === "win32" ? "host.containers.internal" : undefined;

const hostProxyContainerTarget = (arch?: string): ReadonlyArray<HostProxyContainerTarget> => {
  if (arch === "x64" || arch === "amd64" || arch === "x86_64") {
    return [{ os: "linux", arch: "x64" }];
  }
  if (arch === "arm64" || arch === "aarch64") return [{ os: "linux", arch: "arm64" }];
  return [];
};

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

const podmanInfoArchitecture = (info: unknown): string | undefined => {
  if (typeof info !== "object" || info === null) return undefined;
  const host = "host" in info ? info.host : undefined;
  if (typeof host === "object" && host !== null && "arch" in host && typeof host.arch === "string") {
    return host.arch;
  }
  if ("Architecture" in info && typeof info.Architecture === "string") return info.Architecture;
  return undefined;
};

export interface PodmanApiRequest {
  readonly command: "curl";
  readonly args: ReadonlyArray<string>;
  readonly socketUrl: `unix://${string}`;
}

export interface PodmanHttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: `/${string}`;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Uint8Array>;
}

export interface PodmanHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface PodmanApiClient {
  readonly info: Effect.Effect<unknown, ProviderCapabilityError | ProviderUnavailableError>;
  readonly ping: Effect.Effect<void, ProviderCapabilityError | ProviderUnavailableError>;
  readonly request?: (
    request: PodmanHttpRequest,
  ) => Effect.Effect<PodmanHttpResponse, ProviderUnavailableError | ProviderInternalError>;
  readonly stream?: (
    request: PodmanHttpRequest,
  ) => Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError>;
}

export const makePodmanInfoRequest = (socketPath: string): PodmanApiRequest => ({
  command: "curl",
  args: [
    "--silent",
    "--show-error",
    "--fail",
    "--unix-socket",
    socketPath,
    "http://localhost/v6.0.0/libpod/info",
  ],
  socketUrl: `unix://${socketPath}`,
});

export const makePodmanPingRequest = (socketPath: string): PodmanApiRequest => ({
  command: "curl",
  args: [
    "--silent",
    "--show-error",
    "--fail",
    "--unix-socket",
    socketPath,
    "http://localhost/v6.0.0/libpod/_ping",
  ],
  socketUrl: `unix://${socketPath}`,
});

export const decodeProviderCapabilities = (input: unknown) =>
  Schema.decodeUnknown(ProviderCapabilities)(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderCapabilityError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: "provider-lando returned invalid ProviderCapabilities.",
          capability: "ProviderCapabilities",
          requiredValue: "@lando/sdk/schema ProviderCapabilities",
          actualValue: input,
          cause,
        }),
    ),
  );

export const providerLandoCapabilitiesForPlatform = (
  platform: HostPlatform,
  containerTargets: ReadonlyArray<HostProxyContainerTarget> = [],
): ProviderCapabilities => {
  return buildProviderCapabilities({
    bindMounts: platform === "linux" || platform === "darwin" || platform === "win32",
    artifactBuild: true,
    artifactPull: true,
    bindMountPerformance: bindMountPerformanceForPlatform(platform),
    volumeSnapshot: "native",
    serviceFileCopy: "native",
    artifactExport: true,
    artifactImport: true,
    ephemeralMounts: true,
    tlsCertificates: "lando",
    rootless: true,
    composeSpec: "portable",
    providerExtensions: [],
    hostProxy: hostProxyCapabilities(platform, containerTargets),
  });
};

export const linuxMvpCapabilities: ProviderCapabilities = providerLandoCapabilitiesForPlatform("linux");
export const macosMvpCapabilities: ProviderCapabilities = providerLandoCapabilitiesForPlatform("darwin");
export const windowsMvpCapabilities: ProviderCapabilities = providerLandoCapabilitiesForPlatform("win32");
export const mvpProviderCapabilities = (platform: HostPlatform, arch?: string): ProviderCapabilities =>
  providerLandoCapabilitiesForPlatform(platform, hostProxyContainerTarget(arch));

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

interface PodmanApiRequestFailureContext {
  readonly message: string;
  readonly capability: string;
  readonly requiredValue: string;
}

const runPodmanApiRequest = (request: PodmanApiRequest, failure: PodmanApiRequestFailureContext) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([request.command, ...request.args], { stderr: "pipe", stdout: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
    catch: (cause) =>
      new ProviderCapabilityError({
        providerId: PROVIDER_ID,
        operation: "capabilities",
        message: failure.message,
        capability: failure.capability,
        requiredValue: failure.requiredValue,
        actualValue: undefined,
        cause,
      }),
  });

const makeCurlPodmanApiClient = (socketPath: string): PodmanApiClient => ({
  stream: (request) => streamPodmanApiRequest(socketPath, request),
  request: (request) =>
    Effect.gen(function* () {
      const args = [
        "--silent",
        "--show-error",
        "--unix-socket",
        socketPath,
        "--request",
        request.method,
        "--write-out",
        "\n%{http_code}",
      ];

      if (request.body !== undefined) {
        args.push("--header", "Content-Type: application/json", "--data", JSON.stringify(request.body));
      }
      for (const [key, value] of Object.entries(request.headers ?? {})) {
        args.push("--header", `${key}: ${value}`);
      }
      if (request.stdin !== undefined) {
        args.push("--data-binary", "@-");
      }

      args.push(`http://localhost/v6.0.0${request.path}`);

      const { stdout, stderr, exitCode } = yield* Effect.tryPromise({
        try: async () => {
          const payload = await collectRequestStdin(request.stdin);
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
        catch: (cause) =>
          new ProviderUnavailableError({
            providerId: PROVIDER_ID,
            operation: "podman-api",
            message: "Failed to call the Podman API.",
            details: redactDetails({ method: request.method, path: request.path }),
            remediation: TRANSPORT_REMEDIATION,
            cause,
          }),
      });

      if (exitCode !== 0) {
        yield* Effect.fail(
          new ProviderUnavailableError({
            providerId: PROVIDER_ID,
            operation: "podman-api",
            message: `Podman API request failed with exit code ${exitCode}.`,
            details: redactDetails({ method: request.method, path: request.path, stderr }),
            remediation: TRANSPORT_REMEDIATION,
          }),
        );
      }

      const marker = stdout.lastIndexOf("\n");
      const statusText = marker === -1 ? stdout : stdout.slice(marker + 1);
      const status = Number.parseInt(statusText, 10);
      if (!Number.isInteger(status)) {
        yield* Effect.fail(
          new ProviderInternalError({
            providerId: PROVIDER_ID,
            operation: "podman-api",
            message: "Podman API response did not include an HTTP status code.",
            details: redactDetails({ method: request.method, path: request.path, stdout }),
            remediation: TRANSPORT_REMEDIATION,
          }),
        );
      }

      return { status, body: marker === -1 ? "" : stdout.slice(0, marker) };
    }),
  info: Effect.gen(function* () {
    const request = makePodmanInfoRequest(socketPath);
    const { stdout, stderr, exitCode } = yield* runPodmanApiRequest(request, {
      message: "Failed to inspect provider-lando capabilities through the Podman API.",
      capability: "podman-info",
      requiredValue: "Podman HTTP API info response",
    });
    if (exitCode !== 0) {
      yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: `Podman API info request failed with exit code ${exitCode}.`,
          details: redactDetails({ stderr, socketUrl: request.socketUrl }),
          remediation: TRANSPORT_REMEDIATION,
        }),
      );
    }
    return yield* Effect.try({
      try: (): unknown => JSON.parse(stdout),
      catch: (cause) =>
        new ProviderCapabilityError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: "Podman API returned malformed JSON — could not parse info response.",
          capability: "podman-info",
          requiredValue: "valid JSON Podman API info response",
          actualValue: stdout,
          cause,
        }),
    });
  }),
  ping: Effect.gen(function* () {
    const request = makePodmanPingRequest(socketPath);
    const { stderr, exitCode } = yield* runPodmanApiRequest(request, {
      message: "Failed to inspect provider-lando capabilities through the Podman API.",
      capability: "podman-ping",
      requiredValue: "Podman HTTP API ping response",
    });
    if (exitCode !== 0) {
      yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: `Podman API ping request failed with exit code ${exitCode}.`,
          details: redactDetails({ stderr, socketUrl: request.socketUrl }),
          remediation: TRANSPORT_REMEDIATION,
        }),
      );
    }
  }),
});

export const makePodmanApiClient = (socketPath: string): PodmanApiClient =>
  isNamedPipeEndpoint(socketPath)
    ? makeNamedPipePodmanApiClient(socketPath)
    : makeCurlPodmanApiClient(socketPath);

export const introspectProviderCapabilities = (
  api: PodmanApiClient,
  platform: HostPlatform = process.platform === "darwin"
    ? "darwin"
    : process.platform === "linux"
      ? "linux"
      : "win32",
): Effect.Effect<ProviderCapabilities, ProviderCapabilityError | ProviderUnavailableError> =>
  api.info.pipe(
    Effect.map((info) => {
      const containerArch = podmanInfoArchitecture(info);
      return providerLandoCapabilitiesForPlatform(platform, hostProxyContainerTarget(containerArch));
    }),
  );
