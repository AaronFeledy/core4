import { Effect } from "effect";

import { ArtifactBuildError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";

export interface ContainerBuildHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly headers?: Readonly<Record<string, string>>;
  readonly stdin?: AsyncIterable<Uint8Array>;
}

export interface ContainerBuildHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface ContainerBuildHttpApi {
  readonly request?: (
    request: ContainerBuildHttpRequest,
  ) => Effect.Effect<ContainerBuildHttpResponse, ProviderUnavailableError | ProviderInternalError>;
}

export interface ContainerBuildOptions {
  readonly providerId: string;
  readonly api: ContainerBuildHttpApi;
}

type BuildRequestInput = {
  readonly request: NonNullable<ContainerBuildHttpApi["request"]>;
  readonly options: ContainerBuildOptions;
  readonly path: `/${string}`;
  readonly tag: string;
  readonly stdin: AsyncIterable<Uint8Array>;
  readonly secretValues: ReadonlyArray<string>;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const redactBuildQuery = (value: string): string =>
  value.replace(/(buildargs=)(?:[^&\s]+)/giu, "$1[redacted]");

const redactSecrets = (value: string, secretValues: ReadonlyArray<string>): string =>
  redactBuildQuery(
    createRedactor("secrets", {
      authoritativeValues: secretValues.flatMap((secret) => [secret, encodeURIComponent(secret)]),
    }).redactString(value),
  );

const sanitizeBuildErrorValue = (value: unknown, secretValues: ReadonlyArray<string>): unknown => {
  if (typeof value === "string") return redactSecrets(value, secretValues);
  if (Array.isArray(value)) return value.map((entry) => sanitizeBuildErrorValue(entry, secretValues));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeBuildErrorValue(entry, secretValues)]),
  );
};

const sanitizeProviderError = (
  cause: ProviderUnavailableError | ProviderInternalError,
  secretValues: ReadonlyArray<string>,
): ProviderUnavailableError | ProviderInternalError => {
  const input = {
    providerId: cause.providerId,
    operation: cause.operation,
    message: redactSecrets(cause.message, secretValues),
    details: cause.details === undefined ? undefined : sanitizeBuildErrorValue(cause.details, secretValues),
    remediation: cause.remediation,
  };
  return cause instanceof ProviderInternalError
    ? new ProviderInternalError(input)
    : new ProviderUnavailableError(input);
};

const mapRequestError = (
  options: ContainerBuildOptions,
  secretValues: ReadonlyArray<string>,
  cause: ProviderUnavailableError | ProviderInternalError,
): ProviderUnavailableError | ProviderInternalError =>
  cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError
    ? sanitizeProviderError(cause, secretValues)
    : new ProviderUnavailableError({
        providerId: options.providerId,
        operation: "buildArtifact",
        message: "Container image build request failed.",
      });

const buildStreamError = (body: string): string | undefined => {
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      if (typeof parsed.error === "string" && parsed.error.trim().length > 0) return parsed.error;
      if (
        isRecord(parsed.errorDetail) &&
        typeof parsed.errorDetail.message === "string" &&
        parsed.errorDetail.message.trim().length > 0
      ) {
        return parsed.errorDetail.message;
      }
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
    }
  }
  return undefined;
};

const parseDigest = (body: string): string | undefined => {
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && isRecord(parsed.aux) && typeof parsed.aux.Digest === "string") {
        return parsed.aux.Digest;
      }
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
    }
  }
  return undefined;
};

export const requestContainerBuild = (
  input: BuildRequestInput,
): Effect.Effect<string | undefined, ArtifactBuildError | ProviderUnavailableError | ProviderInternalError> =>
  input
    .request({
      method: "POST",
      path: input.path,
      headers: { "Content-Type": "application/x-tar" },
      stdin: input.stdin,
    })
    .pipe(
      Effect.mapError((cause) => mapRequestError(input.options, input.secretValues, cause)),
      Effect.flatMap(
        (response): Effect.Effect<string | undefined, ProviderUnavailableError | ArtifactBuildError> => {
          if (response.status < 200 || response.status >= 300) {
            return Effect.fail(
              new ProviderUnavailableError({
                providerId: input.options.providerId,
                operation: "buildArtifact",
                message: `Container image build failed with HTTP ${response.status}.`,
                details: { status: response.status },
              }),
            );
          }
          const streamError = buildStreamError(response.body);
          if (streamError === undefined) return Effect.succeed(parseDigest(response.body));
          const diagnostic = redactSecrets(streamError, input.secretValues);
          const boundedDiagnostic = diagnostic.length > 4096 ? `${diagnostic.slice(0, 4095)}…` : diagnostic;
          const tag = redactSecrets(input.tag, input.secretValues).slice(0, 256);
          return Effect.fail(
            new ArtifactBuildError({
              providerId: input.options.providerId,
              operation: "buildArtifact",
              message: `Container image build failed: ${boundedDiagnostic}`,
              details: { message: boundedDiagnostic, tag },
              remediation: `Check the failing Containerfile step for image ${tag}, correct it, and rebuild.`,
            }),
          );
        },
      ),
      Effect.flatMap((digest) =>
        input.request({ method: "GET", path: `/images/${encodeURIComponent(input.tag)}/json` }).pipe(
          Effect.mapError((cause) => mapRequestError(input.options, input.secretValues, cause)),
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed(digest)
              : Effect.fail(
                  new ProviderUnavailableError({
                    providerId: input.options.providerId,
                    operation: "buildArtifact",
                    message: `Built image tag ${input.tag} was not available through the container API.`,
                    details: { status: response.status, tag: input.tag },
                  }),
                ),
          ),
        ),
      ),
    );
