import { VolumeOperationError } from "@lando/sdk/errors";
import type { VolumeSnapshotArtifact } from "@lando/sdk/schema";
import { DateTime, Effect, Schema } from "effect";
import type { ProviderDataPlaneOptions } from "./data-plane.ts";
import { SNAPSHOT_ID_LABEL } from "./labels.ts";

const repository = "localhost/lando-volume-snapshot";
const ImageList = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    Size: Schema.Number,
    Created: Schema.Number,
    RepoTags: Schema.NullOr(Schema.Array(Schema.String)),
    Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  }),
);

export const listNativeSnapshots = Effect.fn("ProviderDataPlane.listVolumeSnapshots")(function* (
  options: ProviderDataPlaneOptions,
) {
  if (options.capabilities.volumeSnapshot !== "native") return [];
  const failure = (cause: unknown) =>
    new VolumeOperationError({
      providerId: options.providerId,
      operation: "listVolumeSnapshots",
      message: "Provider snapshot image listing failed.",
      remediation: "Check provider runtime health with lando doctor and retry.",
      cause,
    });
  if (options.api.request === undefined) return yield* Effect.fail(failure("Missing API client"));
  const response = yield* options.api.request({
    method: "GET",
    path: `/images/json?filters=${encodeURIComponent(JSON.stringify({ reference: [`${repository}:*`] }))}`,
  });
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(failure(options.redactDetails(response)));
  }
  const images = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ImageList))(response.body).pipe(
    Effect.mapError(failure),
  );
  const artifacts: VolumeSnapshotArtifact[] = [];
  for (const image of images) {
    const tag = image.RepoTags?.find((tag) => tag.startsWith(`${repository}:`));
    if (tag === undefined) continue;
    const labels = image.Labels ?? {};
    artifacts.push({
      ref: {
        provider: options.providerId,
        id: labels[SNAPSHOT_ID_LABEL] ?? tag.slice(repository.length + 1),
        digest: image.Id,
        sizeBytes: image.Size,
        format: "native",
      },
      createdAt: DateTime.makeUnsafe(image.Created * 1000),
      labels,
    });
  }
  return artifacts;
});
