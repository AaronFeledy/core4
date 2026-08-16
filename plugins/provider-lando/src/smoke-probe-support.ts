import { Duration, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { RetryPolicy } from "@lando/sdk/probe";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "./capabilities.ts";
import { redactDetails } from "./redact.ts";

export const DEFAULT_BASE_IMAGE = "docker.io/library/alpine:3.20.3";
export const defaultSmokeRetryPolicy: RetryPolicy = {
  maxAttempts: 20,
  delay: Duration.millis(500),
  timeout: Duration.seconds(30),
};

export type SmokeOperation = "base-image" | "run" | "build" | "health";

export class ProviderLandoSmokeError extends ProviderUnavailableError {
  readonly smokeOperation: SmokeOperation;

  constructor(input: {
    readonly smokeOperation: SmokeOperation;
    readonly message: string;
    readonly remediation: string;
    readonly details?: unknown;
    readonly cause?: unknown;
  }) {
    super({
      providerId: "lando",
      operation: "setup-smoke",
      message: input.message,
      remediation: input.remediation,
      ...(input.details === undefined ? {} : { details: redactDetails(input.details) }),
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    });
    this.smokeOperation = input.smokeOperation;
  }
}

export interface SmokeProbeDeps {
  readonly podmanApi: PodmanApiClient;
  readonly baseImage?: string;
  readonly retryPolicy?: RetryPolicy;
}

export const smokeRemediation = (operation: SmokeOperation): string => {
  switch (operation) {
    case "base-image":
      return "Check registry connectivity and credentials, then rerun `lando setup --smoke`.";
    case "build":
      return "Check Podman storage and overlay configuration, then rerun `lando setup --smoke`.";
    case "health":
      return "Check container namespace, exec, and healthcheck support, then rerun `lando setup --smoke`.";
    case "run":
      return "Check the OCI runtime and cgroup configuration, then rerun `lando setup --smoke`.";
  }
};

export const smokeApiRequest = (
  deps: SmokeProbeDeps,
  operation: SmokeOperation,
  input: PodmanHttpRequest,
): Effect.Effect<PodmanHttpResponse, ProviderLandoSmokeError> => {
  if (deps.podmanApi.request === undefined) {
    return Effect.fail(
      new ProviderLandoSmokeError({
        smokeOperation: operation,
        message: "The Podman API client cannot perform setup smoke operations.",
        remediation: smokeRemediation(operation),
      }),
    );
  }
  return deps.podmanApi.request(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderLandoSmokeError({
          smokeOperation: operation,
          message: `The provider-lando ${operation} smoke operation could not call the Podman API.`,
          remediation: smokeRemediation(operation),
          details: cause,
          cause,
        }),
    ),
  );
};

export const expectSmokeSuccess = (
  operation: SmokeOperation,
  response: PodmanHttpResponse,
  message: string,
) =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(
        new ProviderLandoSmokeError({
          smokeOperation: operation,
          message,
          remediation: smokeRemediation(operation),
          details: response,
        }),
      );

export const smokeImageExists = (deps: SmokeProbeDeps, image: string, operation: SmokeOperation) =>
  smokeApiRequest(deps, operation, {
    method: "GET",
    path: `/images/${encodeURIComponent(image)}/json`,
  }).pipe(Effect.map((response) => response.status >= 200 && response.status < 300));

export const ensureSmokeBaseImage = (
  deps: SmokeProbeDeps,
  image: string,
): Effect.Effect<void, ProviderLandoSmokeError> =>
  Effect.gen(function* () {
    if (yield* smokeImageExists(deps, image, "base-image")) return;
    const response = yield* smokeApiRequest(deps, "base-image", {
      method: "POST",
      path: `/libpod/images/pull?reference=${encodeURIComponent(image)}`,
    });
    yield* expectSmokeSuccess("base-image", response, `Could not obtain smoke probe base image ${image}.`);
    if (yield* smokeImageExists(deps, image, "base-image")) return;
    return yield* Effect.fail(
      new ProviderLandoSmokeError({
        smokeOperation: "base-image",
        message: `Podman did not resolve smoke probe base image ${image} after pulling it.`,
        remediation: smokeRemediation("base-image"),
        details: { image },
      }),
    );
  });

export const removeSmokeResource = (
  deps: SmokeProbeDeps,
  operation: "run" | "build" | "health",
  path: `/${string}`,
) => smokeApiRequest(deps, operation, { method: "DELETE", path }).pipe(Effect.ignore);

export const acquireSmokeContainer = (
  deps: SmokeProbeDeps,
  input: { readonly operation: "run" | "health"; readonly name: string; readonly body: unknown },
) =>
  Effect.acquireRelease(
    smokeApiRequest(deps, input.operation, {
      method: "POST",
      path: `/containers/create?name=${encodeURIComponent(input.name)}`,
      body: input.body,
    }).pipe(
      Effect.flatMap((response) =>
        expectSmokeSuccess(
          input.operation,
          response,
          `Podman could not create the ${input.operation} smoke container.`,
        ),
      ),
      Effect.as(input.name),
    ),
    (container) =>
      removeSmokeResource(deps, input.operation, `/containers/${encodeURIComponent(container)}?force=true`),
  );

export const startSmokeContainer = (deps: SmokeProbeDeps, operation: "run" | "health", name: string) =>
  smokeApiRequest(deps, operation, {
    method: "POST",
    path: `/containers/${encodeURIComponent(name)}/start`,
  }).pipe(
    Effect.flatMap((response) =>
      expectSmokeSuccess(operation, response, `Podman could not start the ${operation} smoke container.`),
    ),
    Effect.asVoid,
  );

export const parseSmokeExitCode = (body: string): number | undefined => {
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value === "number") return value;
    if (typeof value !== "object" || value === null || !("StatusCode" in value)) return undefined;
    return typeof value.StatusCode === "number" ? value.StatusCode : undefined;
  } catch (cause) {
    if (cause instanceof SyntaxError) return undefined;
    throw cause;
  }
};

const writeTarField = (buffer: Uint8Array, offset: number, length: number, value: string): void => {
  buffer.set(new TextEncoder().encode(value).slice(0, length), offset);
};

export const smokeBuildContext = (baseImage: string): AsyncIterable<Uint8Array> => {
  const contents = new TextEncoder().encode(`FROM ${baseImage}\n`);
  const output = new Uint8Array(512 + Math.ceil(contents.length / 512) * 512 + 1024);
  writeTarField(output, 0, 100, "Dockerfile");
  writeTarField(output, 100, 8, "0000644\0");
  writeTarField(output, 108, 8, "0000000\0");
  writeTarField(output, 116, 8, "0000000\0");
  writeTarField(output, 124, 12, `${contents.length.toString(8).padStart(11, "0")}\0`);
  writeTarField(output, 136, 12, "00000000000\0");
  output.fill(32, 148, 156);
  output[156] = "0".charCodeAt(0);
  writeTarField(output, 257, 6, "ustar\0");
  writeTarField(output, 263, 2, "00");
  const checksum = output.slice(0, 512).reduce((sum, byte) => sum + byte, 0);
  writeTarField(output, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  output.set(contents, 512);
  return {
    async *[Symbol.asyncIterator]() {
      yield output;
    },
  };
};

export const parseSmokeHealth = (body: string): "healthy" | "starting" | "unhealthy" | "invalid" => {
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value !== "object" || value === null || !("State" in value)) return "invalid";
    const state = value.State;
    if (typeof state !== "object" || state === null || !("Health" in state)) return "invalid";
    const health = state.Health;
    if (typeof health !== "object" || health === null || !("Status" in health)) return "invalid";
    const status = health.Status;
    return status === "healthy" || status === "starting" || status === "unhealthy" ? status : "invalid";
  } catch (cause) {
    if (cause instanceof SyntaxError) return "invalid";
    throw cause;
  }
};
