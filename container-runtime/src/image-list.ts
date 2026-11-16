import { mapFailures } from "@lando/sdk/command-result";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { ArtifactListing, ArtifactSelector } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { type EngineHttpApi, type ProviderErrorContext, isSuccessStatus } from "./engine-api.ts";
import { missingApi, parseEngineJson } from "./engine-errors.ts";
import { redactResponseDetails, redactorFor, withApiReason } from "./redact.ts";

export const normalizeImageRef = (ref: string): string =>
  ref.replace(/^(?:docker\.io\/library\/|localhost\/)/u, "").replace(/:latest$/u, "");

const Images = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    RepoTags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  }),
);

export const listContainerArtifacts = Effect.fn("RuntimeProvider.listArtifacts")(function* (
  api: EngineHttpApi,
  selector: ArtifactSelector,
  ctx: ProviderErrorContext,
): Effect.fn.Return<ReadonlyArray<ArtifactListing>, ProviderUnavailableError | ProviderInternalError> {
  const request = api.request;
  if (request === undefined) return yield* Effect.fail(missingApi(ctx, "listArtifacts"));
  const redactor = redactorFor(ctx);
  const filters = JSON.stringify({
    label: Object.entries(selector.labels).map(([key, value]) => `${key}=${value}`),
  });
  const response = yield* request({
    method: "GET",
    path: `/images/json?filters=${encodeURIComponent(filters)}`,
  }).pipe(
    mapFailures((cause) => {
      const fields = {
        providerId: ctx.providerId,
        operation: "listArtifacts",
        message: redactor.redactString(cause.message),
        remediation: ctx.remediation,
        cause,
      };
      return cause instanceof ProviderUnavailableError
        ? new ProviderUnavailableError(fields)
        : new ProviderInternalError(fields);
    }),
  );
  if (!isSuccessStatus(response.status))
    return yield* Effect.fail(
      new ProviderInternalError({
        providerId: ctx.providerId,
        operation: "listArtifacts",
        message: withApiReason(`Image listing failed with HTTP ${response.status}.`, response, redactor),
        details: redactResponseDetails(response, redactor),
        remediation: ctx.remediation,
      }),
    );
  const body = yield* parseEngineJson(response, ctx, "listArtifacts");
  const images = yield* Schema.decodeUnknownEffect(Images)(body).pipe(
    mapFailures(
      () =>
        new ProviderInternalError({
          providerId: ctx.providerId,
          operation: "listArtifacts",
          message: "Image listing returned an invalid image list.",
          remediation: ctx.remediation,
        }),
    ),
  );
  return images.map((image) => ({
    id: image.Id,
    refs: (image.RepoTags ?? []).filter((ref) => ref !== "<none>:<none>").map(normalizeImageRef),
  }));
});
