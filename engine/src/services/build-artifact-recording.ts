import { mapFailures, orDieWithRole } from "@lando/sdk/command-result";
import { PathsService } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { withBuiltArtifactsLock } from "./build-artifact-lock.ts";
import {
  type ArtifactBuildResult,
  type ArtifactResultsBucket,
  claimArtifactBuild,
  recordArtifactBuildResult,
  settleArtifactBuildClaim,
} from "./build-artifact-results.ts";
import { buildResultsError } from "./build-results.ts";

type ArtifactReceipt = Pick<
  ArtifactBuildResult,
  | "owner"
  | "providerId"
  | "buildKey"
  | "service"
  | "phase"
  | "artifactRef"
  | "transcriptPath"
  | "artifactOrigin"
>;

export const openArtifactBuildRecording = Effect.fnUntraced(function* (
  bucket: ArtifactResultsBucket,
  receipt: ArtifactReceipt,
  activity: { dispatched: boolean; dropped: boolean },
) {
  const paths = yield* PathsService;
  const started = performance.now();
  let claimId: string | undefined;
  let completed = false;
  const record = (entry: Parameters<typeof recordArtifactBuildResult>[1]) =>
    withBuiltArtifactsLock(recordArtifactBuildResult(bucket, entry)).pipe(
      Effect.provideService(PathsService, paths),
      Effect.tap((dropped) =>
        Effect.sync(() => {
          activity.dropped ||= dropped.length > 0;
        }),
      ),
      mapFailures((cause) => buildResultsError(receipt.providerId, cause)),
    );
  yield* Effect.addFinalizer((exit) =>
    (Exit.isSuccess(exit) || completed || Cause.hasInterruptsOnly(exit.cause)
      ? Effect.void
      : record({ ...receipt, outcome: "fail", durationMs: performance.now() - started }).pipe(
          Effect.exit,
          Effect.asVoid,
        )
    ).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (claimId === undefined) return;
          const dropped = yield* withBuiltArtifactsLock(settleArtifactBuildClaim(bucket, claimId)).pipe(
            Effect.provideService(PathsService, paths),
          );
          activity.dropped ||= dropped.length > 0;
        }).pipe(orDieWithRole("cleanup")),
      ),
    ),
  );
  return {
    dispatch: Effect.uninterruptible(
      Effect.gen(function* () {
        const claimed = yield* withBuiltArtifactsLock(claimArtifactBuild(bucket, receipt)).pipe(
          Effect.provideService(PathsService, paths),
          mapFailures((cause) => buildResultsError(receipt.providerId, cause)),
        );
        claimId = claimed.claim.id;
        activity.dropped ||= claimed.dropped.length > 0;
        activity.dispatched = true;
      }),
    ),
    complete: (
      artifact: Pick<
        ArtifactBuildResult,
        "artifactRef" | "artifactDigest" | "artifactOrigin" | "sourceArtifactRef" | "sourceArtifactDigest"
      >,
    ) =>
      record({ ...receipt, ...artifact, outcome: "complete", durationMs: performance.now() - started }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
      ),
  };
});
