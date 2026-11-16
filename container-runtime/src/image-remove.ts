import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { ArtifactRemoval, ArtifactRemovalRequest } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { type EngineHttpApi, type ProviderErrorContext, isSuccessStatus } from "./engine-api.ts";
import { missingApi, parseEngineJson } from "./engine-errors.ts";
import { apiReasonFromBody, redactResponseDetails, redactorFor, withApiReason } from "./redact.ts";

export const removeContainerArtifact = Effect.fn("RuntimeProvider.removeArtifact")(function* (
  api: EngineHttpApi,
  input: ArtifactRemovalRequest,
  ctx: ProviderErrorContext,
): Effect.fn.Return<ArtifactRemoval, ProviderUnavailableError | ProviderInternalError> {
  const request = api.request;
  if (request === undefined) return yield* Effect.fail(missingApi(ctx, "removeArtifact"));
  const redactor = redactorFor(ctx);
  const mapRemovalError = (cause: ProviderUnavailableError | ProviderInternalError) => {
    const fields = {
      providerId: ctx.providerId,
      operation: "removeArtifact",
      message: redactor.redactString(cause.message),
      remediation: ctx.remediation,
      cause,
    };
    return cause instanceof ProviderUnavailableError
      ? new ProviderUnavailableError(fields)
      : new ProviderInternalError(fields);
  };
  const reference = input.ref;
  const response = yield* request({
    method: "DELETE",
    path: `/images/${encodeURIComponent(reference)}${input.pruneParents ? "" : "?noprune=true"}`,
  }).pipe(mapFailures(mapRemovalError));
  if (response.status === 409) {
    const filters = JSON.stringify({ ancestor: [reference.replace(/^sha256:/u, "")] });
    const users = yield* request({
      method: "GET",
      path: `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    }).pipe(mapFailures(mapRemovalError));
    if (!isSuccessStatus(users.status))
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: ctx.providerId,
          operation: "removeArtifact",
          message: withApiReason(
            `Image container listing failed with HTTP ${users.status}.`,
            users,
            redactor,
          ),
          details: redactResponseDetails(users, redactor),
          remediation: ctx.remediation,
        }),
      );
    const body = yield* parseEngineJson(users, ctx, "removeArtifact");
    const containers = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ Names: Schema.Array(Schema.String) })),
    )(body).pipe(
      mapFailures(
        () =>
          new ProviderInternalError({
            providerId: ctx.providerId,
            operation: "removeArtifact",
            message: "Image container listing returned invalid container names.",
            remediation: ctx.remediation,
          }),
      ),
    );
    return {
      kind: "in-use",
      containers: containers.flatMap((container) =>
        container.Names.map((name) => redactor.redactString(name.replace(/^\//u, ""))),
      ),
      reason: apiReasonFromBody(response, redactor) ?? redactor.redactString(`Image ${reference} is in use.`),
    };
  }
  if (response.status === 404) return { kind: "absent" };
  if (isSuccessStatus(response.status)) {
    return { kind: "removed" };
  }
  return yield* Effect.fail(
    new ProviderInternalError({
      providerId: ctx.providerId,
      operation: "removeArtifact",
      message: withApiReason(`Image removal failed with HTTP ${response.status}.`, response, redactor),
      details: redactResponseDetails(response, redactor),
      remediation: ctx.remediation,
    }),
  );
});
