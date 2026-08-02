import { Effect, Either, Schema } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import type { ContainerBuildHttpApi } from "./image-build-http.ts";

type InspectInheritedImageUserInput = {
  readonly baseRef: string;
  readonly providerId: string;
  readonly request: NonNullable<ContainerBuildHttpApi["request"]>;
};

const ImageInspect = Schema.Struct({
  Config: Schema.Struct({ User: Schema.optional(Schema.String) }),
});

const unsafeInheritedUserPattern = /[\p{White_Space}\p{Cc}\\]/u;

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
): Effect.Effect<string | undefined, ProviderUnavailableError | ProviderInternalError> =>
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
      user !== undefined && user !== "" && unsafeInheritedUserPattern.test(user)
        ? Effect.fail(
            inspectionError(
              input,
              "Invalid inherited image user: whitespace, control characters, and backslashes are not allowed.",
            ),
          )
        : Effect.succeed(user),
    ),
    Effect.map((user) => {
      const identity = user?.split(":", 1)[0];
      return user === undefined || user === "" || identity === "root" || identity === "0" ? undefined : user;
    }),
  );
