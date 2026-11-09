import { mapFailures } from "@lando/sdk/command-result";
import { ProviderCapabilityError, ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";
import { tryParseJson } from "./engine-json.ts";

const BorrowedMountInspect = Schema.Struct({
  HostConfig: Schema.Struct({
    Mounts: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            VolumeOptions: Schema.optionalKey(
              Schema.NullOr(Schema.Struct({ Subpath: Schema.optionalKey(Schema.String) })),
            ),
          }),
        ),
      ),
    ),
  }),
});

export const requireBorrowableMounts = Effect.fn("DataPlane.requireBorrowableMounts")(function* (
  providerId: string,
  body: string,
) {
  const failure = () =>
    new ProviderUnavailableError({
      providerId,
      operation: "run.mountsFrom",
      message: "Cannot inspect borrowed container mounts.",
      remediation: "Check the source service container and retry with lando start.",
    });
  const parsed = yield* tryParseJson(body, failure);
  const record = yield* Schema.decodeUnknownEffect(BorrowedMountInspect)(parsed).pipe(mapFailures(failure));
  if (record.HostConfig.Mounts?.some((mount) => (mount.VolumeOptions?.Subpath?.length ?? 0) > 0))
    return yield* Effect.fail(
      new ProviderCapabilityError({
        providerId,
        operation: "run.mountsFrom",
        capability: "volume-subpath",
        requiredValue: "Borrowed mounts preserving volume subpaths",
        actualValue: "VolumesFrom drops Subpath",
        message: "Cannot safely borrow a container mount with a volume subpath.",
        remediation: "The provider cannot preserve borrowed volume subpaths; the helper was not started.",
      }),
    );
});
