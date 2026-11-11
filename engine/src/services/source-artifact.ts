import { serviceImagePlatform } from "@lando/container-runtime/image-ensure";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { ServicePlan } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type {
  ArtifactPullPolicy,
  ArtifactRef,
  EventService,
  ProviderError,
  RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { type Context, DateTime, Effect } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";
import {
  acquireReferencedArtifact,
  openPullChecks,
  pullCheckKey,
  readArtifactRefreshAfterMs,
  recordPullCheck,
} from "./artifact-refresh.ts";

interface SourceArtifactOptions {
  readonly refresh: boolean;
  readonly stateStore: Context.Service.Shape<typeof StateStore>;
  readonly events: Context.Service.Shape<typeof EventService>;
  readonly redactor: Pick<Redactor, "redactString">;
}

type SourceRef = Extract<NonNullable<ServicePlan["artifact"]>, { readonly kind: "ref" }>;

/**
 * Pull policy for one acquisition. An explicit service policy is authoritative on start and rebuild;
 * without one, start pulls only a missing image and rebuild refreshes with a local fallback.
 */
const acquisitionPolicy = (
  service: ServicePlan,
  refresh: boolean,
): { readonly policy: ArtifactPullPolicy; readonly localFallback: boolean } => {
  switch (service.pullPolicy) {
    case "always":
      return { policy: "always", localFallback: false };
    case "never":
      return { policy: "never", localFallback: false };
    case "build":
    case undefined:
      return refresh
        ? { policy: "always", localFallback: true }
        : { policy: "missing", localFallback: false };
    default:
      return service.pullPolicy satisfies never;
  }
};

const warnRefreshFallback = Effect.fnUntraced(function* (
  service: ServicePlan,
  artifact: SourceRef,
  error: ProviderError,
  options: SourceArtifactOptions,
) {
  const message = options.redactor.redactString(
    `Couldn't refresh ${artifact.ref}, so ${service.name} uses the local copy. ${error.message}`,
  );
  yield* recordCommandWarning({
    code: "LANDO_ARTIFACT_REFRESH_FAILED",
    message,
    remediation: "Rebuild again once the registry is reachable to pick up updated images.",
    context: {
      service: String(service.name),
      artifact: options.redactor.redactString(artifact.ref),
      cause: error._tag,
    },
  });
  if (yield* commandWarningsUseMachineOutput) return;
  yield* options.events
    .publish(MessageWarnEvent.make({ body: message, timestamp: yield* DateTime.now }))
    .pipe(Effect.catch(() => Effect.void));
});

/** Acquires a service's source image ref according to its pull policy before any build runs. */
export const resolveSourceArtifact = (
  provider: RuntimeProviderShape,
  service: ServicePlan,
  options: SourceArtifactOptions,
): Effect.Effect<ArtifactRef | undefined, ProviderError> => {
  const artifact = service.artifact;
  if (artifact?.kind !== "ref") return Effect.succeed(undefined);
  if (!provider.capabilities.artifactPull) {
    return Effect.succeed(
      artifact.digest === undefined
        ? undefined
        : { providerId: service.provider, ref: artifact.ref, digest: artifact.digest },
    );
  }
  const platform = serviceImagePlatform(service);
  const pull = (policy: ArtifactPullPolicy) =>
    provider.pullArtifact({ ref: artifact.ref, policy, ...(platform === undefined ? {} : { platform }) });
  if (service.pullPolicy !== undefined) {
    const { policy, localFallback } = acquisitionPolicy(service, options.refresh);
    if (!localFallback) return pull(policy);
    return pull(policy).pipe(
      Effect.catch((error) =>
        pull("never").pipe(
          Effect.catch(() => Effect.fail(error)),
          Effect.tap(() => warnRefreshFallback(service, artifact, error, options)),
        ),
      ),
    );
  }
  const refreshAfterMs = readArtifactRefreshAfterMs(service.extensions);
  return Effect.gen(function* () {
    const runtimeId = provider.runtimeIdentity ?? `${provider.id}:${provider.platform}`;
    const key = pullCheckKey({ runtimeId, platform: provider.platform, ref: artifact.ref });
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const checks = yield* openPullChecks(options.stateStore).pipe(
      Effect.flatMap((bucket) => bucket.get),
      Effect.catch(() => Effect.succeed(null)),
    );
    const onChecked =
      refreshAfterMs === undefined
        ? Effect.void
        : Effect.gen(function* () {
            const checkedAt = DateTime.toEpochMillis(yield* DateTime.now);
            const bucket = yield* openPullChecks(options.stateStore);
            yield* recordPullCheck(bucket, key, {
              ref: artifact.ref,
              platform: provider.platform,
              runtimeId,
              checkedAt,
              afterMs: refreshAfterMs,
            });
          });
    return yield* acquireReferencedArtifact({
      pull,
      forced: options.refresh,
      refreshAfterMs,
      checkedAt: checks?.[key]?.checkedAt,
      now,
      onChecked,
      onFallback: (error) => warnRefreshFallback(service, artifact, error, options),
    });
  });
};
