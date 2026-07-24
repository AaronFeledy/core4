import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

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
  secretValues.reduce((redacted, secret) => {
    if (secret.length === 0) return redacted;
    return redacted.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]");
  }, redactBuildQuery(value));

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
): Effect.Effect<string | undefined, ProviderUnavailableError | ProviderInternalError> =>
  input
    .request({
      method: "POST",
      path: input.path,
      headers: { "Content-Type": "application/x-tar" },
      stdin: input.stdin,
    })
    .pipe(
      Effect.mapError((cause) => mapRequestError(input.options, input.secretValues, cause)),
      Effect.flatMap((response) => {
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
        return streamError === undefined
          ? Effect.succeed(parseDigest(response.body))
          : Effect.fail(
              new ProviderUnavailableError({
                providerId: input.options.providerId,
                operation: "buildArtifact",
                message: "Container image build stream reported an error.",
                details: { message: redactSecrets(streamError, input.secretValues) },
              }),
            );
      }),
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
