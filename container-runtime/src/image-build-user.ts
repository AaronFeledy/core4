import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { CONTAINER_USER_PATTERN, isContainerUser } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";

import { tryParseJson } from "./engine-json.ts";
import type { ContainerBuildHttpApi } from "./image-build-http.ts";

type ImageUserInspectionInput = {
  readonly baseRef: string;
  readonly providerId: string;
  readonly request: NonNullable<ContainerBuildHttpApi["request"]>;
  /** Operation named by a failure; defaults to the image-build path. */
  readonly operation?: "buildArtifact" | "bringUp.create";
  /** Subject named by a failure, for example "inherited image user". */
  readonly subject?: string;
};

const ImageInspect = Schema.Struct({
  Config: Schema.Struct({ User: Schema.optionalKey(Schema.String) }),
});

export const validateDockerfileUser = (
  value: unknown,
  field: string,
  providerId: string,
  operation = "buildArtifact",
): Effect.Effect<string, ProviderInternalError> =>
  typeof value === "string" && isContainerUser(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new ProviderInternalError({
          providerId,
          operation,
          message: `Invalid ${field}: expected a Docker USER token matching ${CONTAINER_USER_PATTERN}; whitespace, control characters, and backslashes are not allowed.`,
          remediation:
            "Use a non-empty user or user:group identity containing only letters, digits, underscores, dots, and hyphens, starting each part with a letter, digit, or underscore.",
        }),
      );

const inspectionRemediation = (input: ImageUserInspectionInput): string =>
  `Verify that ${input.baseRef} is available and returns valid image configuration through the container API.`;

const inspectionError = (
  input: ImageUserInspectionInput,
  message: string,
  cause?: unknown,
): ProviderInternalError =>
  new ProviderInternalError({
    providerId: input.providerId,
    operation: input.operation ?? "buildArtifact",
    message,
    remediation: inspectionRemediation(input),
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Reads the image's configured user without running anything inside it. The
 * result is the identity a create request must name explicitly when a user
 * namespace is in play, and an empty configuration means root.
 */
export const inspectImageUser = (
  input: ImageUserInspectionInput,
): Effect.Effect<string, ProviderUnavailableError | ProviderInternalError> =>
  input
    .request({
      method: "GET",
      path: `/images/${encodeURIComponent(input.baseRef.replace(/^sha256:/u, ""))}/json`,
    })
    .pipe(
      mapFailures((cause) =>
        cause instanceof ProviderUnavailableError
          ? cause
          : inspectionError(
              input,
              `Unable to inspect ${input.subject ?? "image"} user for ${input.baseRef}.`,
              cause,
            ),
      ),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response.body)
          : Effect.fail(
              new ProviderUnavailableError({
                providerId: input.providerId,
                operation: input.operation ?? "buildArtifact",
                message: `${input.subject ?? "Image"} user inspection failed with HTTP ${response.status}.`,
                remediation: inspectionRemediation(input),
              }),
            ),
      ),
      Effect.flatMap((body) =>
        tryParseJson(body, (cause) =>
          inspectionError(
            input,
            `${input.subject ?? "Image"} user inspection returned malformed JSON.`,
            cause,
          ),
        ),
      ),
      Effect.flatMap((value) => {
        const decoded = Schema.decodeUnknownResult(ImageInspect)(value);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success.Config.User)
          : Effect.fail(
              inspectionError(
                input,
                `${input.subject ?? "Image"} user inspection returned malformed configuration.`,
                decoded.failure,
              ),
            );
      }),
      Effect.flatMap((user) =>
        validateDockerfileUser(
          user === undefined || user === "" ? "root" : user,
          `${input.subject ?? "image"} user`,
          input.providerId,
          input.operation ?? "buildArtifact",
        ),
      ),
    );

export const inspectInheritedImageUser = (
  input: Pick<ImageUserInspectionInput, "baseRef" | "providerId" | "request">,
): Effect.Effect<string, ProviderUnavailableError | ProviderInternalError> =>
  inspectImageUser({ ...input, subject: "inherited image" });
