import { Effect, Either, Schema } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { CONTAINER_USER_PATTERN, isContainerUser } from "@lando/sdk/schema";

import type { ContainerBuildHttpApi } from "./image-build-http.ts";

type InspectInheritedImageUserInput = {
  readonly baseRef: string;
  readonly providerId: string;
  readonly request: NonNullable<ContainerBuildHttpApi["request"]>;
};

const ImageInspect = Schema.Struct({
  Config: Schema.Struct({ User: Schema.optional(Schema.String) }),
});

export const validateDockerfileUser = (
  value: unknown,
  field: string,
  providerId: string,
): Effect.Effect<string, ProviderInternalError> =>
  typeof value === "string" && isContainerUser(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new ProviderInternalError({
          providerId,
          operation: "buildArtifact",
          message: `Invalid ${field}: expected a Docker USER token matching ${CONTAINER_USER_PATTERN}; whitespace, control characters, and backslashes are not allowed.`,
          remediation:
            "Use a non-empty user or user:group identity containing only letters, digits, underscores, dots, and hyphens, starting each part with a letter, digit, or underscore.",
        }),
      );

const inspectionRemediation = (input: InspectInheritedImageUserInput): string =>
  `Verify that ${input.baseRef} is available and returns valid image configuration through the container API.`;

const inspectionError = (
  input: InspectInheritedImageUserInput,
  message: string,
  cause?: unknown,
): ProviderInternalError =>
  new ProviderInternalError({
    providerId: input.providerId,
    operation: "buildArtifact",
    message,
    remediation: inspectionRemediation(input),
    ...(cause === undefined ? {} : { cause }),
  });

export const inspectInheritedImageUser = (
  input: InspectInheritedImageUserInput,
): Effect.Effect<string, ProviderUnavailableError | ProviderInternalError> =>
  input.request({ method: "GET", path: `/images/${encodeURIComponent(input.baseRef)}/json` }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ProviderUnavailableError
        ? cause
        : inspectionError(input, `Unable to inspect inherited image user for ${input.baseRef}.`, cause),
    ),
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response.body)
        : Effect.fail(
            new ProviderUnavailableError({
              providerId: input.providerId,
              operation: "buildArtifact",
              message: `Inherited image user inspection failed with HTTP ${response.status}.`,
              remediation: inspectionRemediation(input),
            }),
          ),
    ),
    Effect.flatMap((body) =>
      Effect.try({
        try: (): unknown => JSON.parse(body),
        catch: (cause) =>
          inspectionError(input, "Inherited image user inspection returned malformed JSON.", cause),
      }),
    ),
    Effect.flatMap((value) => {
      const decoded = Schema.decodeUnknownEither(ImageInspect)(value);
      return Either.isRight(decoded)
        ? Effect.succeed(decoded.right.Config.User)
        : Effect.fail(
            inspectionError(
              input,
              "Inherited image user inspection returned malformed configuration.",
              decoded.left,
            ),
          );
    }),
    Effect.flatMap((user) =>
      validateDockerfileUser(
        user === undefined || user === "" ? "root" : user,
        "inherited image user",
        input.providerId,
      ),
    ),
  );
