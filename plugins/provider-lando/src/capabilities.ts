import { Effect, Schema } from "effect";

import { ProviderCapabilityError, ProviderUnavailableError } from "@lando/sdk/errors";
import { ProviderCapabilities } from "@lando/sdk/schema";

const PROVIDER_ID = "lando";

export interface PodmanApiRequest {
  readonly command: "curl";
  readonly args: ReadonlyArray<string>;
  readonly socketUrl: `unix://${string}`;
}

export interface PodmanApiClient {
  readonly info: Effect.Effect<unknown, ProviderCapabilityError | ProviderUnavailableError>;
}

export const makePodmanInfoRequest = (socketPath: string): PodmanApiRequest => ({
  command: "curl",
  args: [
    "--silent",
    "--show-error",
    "--fail",
    "--unix-socket",
    socketPath,
    "http://localhost/v5.0.0/libpod/info",
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

export const linuxMvpCapabilities: ProviderCapabilities = Schema.decodeSync(ProviderCapabilities)({
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: false,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: process.platform === "linux" ? "native" : "none",
  copyMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
});

export const makePodmanApiClient = (socketPath: string): PodmanApiClient => ({
  info: Effect.gen(function* () {
    const request = makePodmanInfoRequest(socketPath);
    // Unexpected JS exceptions (spawn failure, etc.) become ProviderCapabilityError.
    const { stdout, stderr, exitCode } = yield* Effect.tryPromise({
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
          message: "Failed to inspect provider-lando capabilities through the Podman API.",
          capability: "podman-info",
          requiredValue: "Podman HTTP API info response",
          actualValue: undefined,
          cause,
        }),
    });
    // Non-zero exit indicates the daemon is unreachable — surface as ProviderUnavailableError
    // so consumers can discriminate between "daemon down" and "capability query failed".
    if (exitCode !== 0) {
      yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: `Podman API info request failed with exit code ${exitCode}.`,
          details: { stderr, socketUrl: request.socketUrl },
        }),
      );
    }
    return yield* Effect.try({
      try: () => JSON.parse(stdout) as unknown,
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
});

export const introspectProviderCapabilities = (
  api: PodmanApiClient,
): Effect.Effect<ProviderCapabilities, ProviderCapabilityError | ProviderUnavailableError> =>
  api.info.pipe(Effect.flatMap(() => decodeProviderCapabilities(linuxMvpCapabilities)));
