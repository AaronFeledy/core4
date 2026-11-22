import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import { type AppId, type OwnedResourcesCleanupResult, noVolumesRemoved } from "@lando/sdk/schema";
import { type ProviderError, StateStore } from "@lando/sdk/services";
import { withPhysicalVolumeLocks } from "@lando/state-store/volume-lock";
import { Context, Effect, Option, Schema } from "effect";
import type { EngineHttpRequest, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import {
  isVolumeInUse,
  listVolumeHolders,
  volumeInUseMessage,
  volumeInUseRemediation,
} from "./ephemeral-data-helpers.ts";
import type { HelperReclaimOptions } from "./helper-owner.ts";
import { STORE_LABEL, VOLUME_INSTANCE_LABEL } from "./labels.ts";
import { NativeVolumeSchema, volumeCoordinationKey } from "./native-volume-identity.ts";
import type { VolumeSelectorClass } from "./podman/volume-prune.ts";
import { redactDetails, redactorFor, withApiReason } from "./redact.ts";
import { removeAllStaleVolumeHolders } from "./stale-data-helpers.ts";
import { hasSharedCacheOwnership } from "./volume-ownership.ts";

export interface TeardownVolumeRuntime {
  readonly request: (request: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, ProviderError>;
  readonly ctx: ProviderErrorContext;
  readonly endpointNamespace?: string;
  readonly helperReclaim?: HelperReclaimOptions;
}

export interface VolumeDeletion {
  readonly appId: AppId;
  readonly name: string;
  readonly volumeClass: VolumeSelectorClass;
  readonly shared: boolean;
  readonly matches: (labels: Readonly<Record<string, string>>) => boolean;
}

export type SkippedVolume = NonNullable<OwnedResourcesCleanupResult["skipped"]>[number];

export const PlanfulVolumeCoverage = Context.Reference<
  | {
      readonly provider: string;
      readonly app: AppId;
    }
  | undefined
>("@lando/container-runtime/PlanfulVolumeCoverage", { defaultValue: () => undefined });

export const matchesSharedCache = (
  providerId: string,
  name: string,
  labels: Readonly<Record<string, string>>,
) => labels[STORE_LABEL] === name && hasSharedCacheOwnership(labels, providerId);

const volumePath = (name: string): EngineHttpRequest["path"] => `/volumes/${encodeURIComponent(name)}`;

export const teardownVolumeFailure = (ctx: ProviderErrorContext, message: string, details?: unknown) =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "bringDown.volume",
    message: withApiReason(message, details, redactorFor(ctx)),
    remediation: ctx.remediation,
    ...(details === undefined ? {} : { details: redactDetails(details, redactorFor(ctx)) }),
  });

const inspect = Effect.fnUntraced(function* (runtime: TeardownVolumeRuntime, name: string) {
  const response = yield* runtime.request({ method: "GET", path: volumePath(name) });
  if (response.status === 404) return undefined;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(NativeVolumeSchema))(response.body);
  if (response.status !== 200 || Option.isNone(decoded) || decoded.value.Name !== name)
    return yield* teardownVolumeFailure(runtime.ctx, `Could not inspect volume ${name}.`, response);
  return decoded.value.Labels ?? {};
});

export const snapshotVolumeDeletion = Effect.fnUntraced(function* (
  runtime: TeardownVolumeRuntime,
  deletion: VolumeDeletion,
  listedLabels?: Readonly<Record<string, string>>,
) {
  const labels = listedLabels ?? (yield* inspect(runtime, deletion.name));
  if (labels === undefined) return { kind: "absent" } as const;
  const generation = labels[VOLUME_INSTANCE_LABEL];
  if (!generation || !deletion.matches(labels)) return { kind: "unverified" } as const;
  const key = yield* volumeCoordinationKey(
    { ...runtime, api: runtime, providerId: runtime.ctx.providerId },
    deletion.name,
  );
  if (key === undefined)
    return yield* teardownVolumeFailure(
      runtime.ctx,
      `Could not identify the endpoint for volume ${deletion.name}.`,
    );
  return { kind: "candidate", candidate: { ...deletion, generation, key } } as const;
});

export type VolumeDeletionCandidate = Extract<
  Effect.Success<ReturnType<typeof snapshotVolumeDeletion>>,
  { kind: "candidate" }
>["candidate"];

const deleteCandidate = Effect.fnUntraced(function* (
  runtime: TeardownVolumeRuntime,
  candidate: VolumeDeletionCandidate,
) {
  const { name, shared } = candidate;
  const unchanged = inspect(runtime, name).pipe(
    Effect.map(
      (labels) =>
        labels !== undefined &&
        labels[VOLUME_INSTANCE_LABEL] === candidate.generation &&
        candidate.matches(labels),
    ),
  );
  if (!(yield* unchanged)) return "changed" as const;
  const remove = runtime.request({ method: "DELETE", path: volumePath(name) });
  let response = yield* remove;
  if (shared && isVolumeInUse(response)) return "in use" as const;
  if (isVolumeInUse(response)) {
    const redactor = redactorFor(runtime.ctx);
    let holders = yield* listVolumeHolders(runtime.request, name);
    if (
      yield* removeAllStaleVolumeHolders(runtime.request, {
        ...runtime,
        providerId: runtime.ctx.providerId,
        holders,
        redactor,
      })
    ) {
      if (!(yield* unchanged)) return "changed" as const;
      response = yield* remove;
      if (isVolumeInUse(response)) holders = yield* listVolumeHolders(runtime.request, name);
    }
    if (isVolumeInUse(response))
      return yield* new ProviderUnavailableError({
        providerId: runtime.ctx.providerId,
        operation: "bringDown.volume",
        message: volumeInUseMessage(`Volume ${name} could not be removed.`, holders, response, redactor),
        remediation: volumeInUseRemediation(redactor),
        details: redactDetails({ name, status: response.status, body: response.body }, redactor),
      });
  }
  if (response.status === 200 || response.status === 204) return "removed" as const;
  if (response.status === 404) return "absent" as const;
  return yield* teardownVolumeFailure(
    runtime.ctx,
    `Could not remove volume ${name} (HTTP ${response.status}).`,
    { name, body: response.body },
  );
});

export const skippedVolume = (volume: VolumeDeletion, reason: string): SkippedVolume => ({
  appId: volume.appId,
  resource: volume.name,
  reason,
});

export const deleteVolumeSnapshot = Effect.fnUntraced(function* (
  runtime: TeardownVolumeRuntime,
  snapshot: ReadonlyArray<VolumeDeletionCandidate>,
) {
  const volumesRemoved = { ...noVolumesRemoved };
  const retired = new Set<string>();
  const skipped: SkippedVolume[] = [];
  if (snapshot.length === 0) return { volumesRemoved, retired, skipped };
  const state = yield* Effect.serviceOption(StateStore);
  const work = (candidates: ReadonlyArray<VolumeDeletionCandidate>) => {
    if (Option.isNone(state))
      return Effect.fail(
        teardownVolumeFailure(runtime.ctx, "Volume deletion requires the physical volume lock service."),
      );
    return withPhysicalVolumeLocks(
      state.value,
      candidates.map(({ key, name }) => ({ key, name, mode: "exclusive", resource: `volume ${name}` })),
      Effect.forEach(
        candidates,
        (candidate) =>
          deleteCandidate(runtime, candidate).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                switch (outcome) {
                  case "removed":
                    volumesRemoved[candidate.volumeClass] += 1;
                    retired.add(candidate.name);
                    break;
                  case "absent":
                    retired.add(candidate.name);
                    break;
                  case "changed":
                    skipped.push(skippedVolume(candidate, "volume changed after enumeration"));
                    break;
                  case "in use":
                    skipped.push(skippedVolume(candidate, "in use"));
                    break;
                }
              }),
            ),
          ),
        { discard: true },
      ),
    );
  };
  const appVolumes = snapshot.filter((candidate) => !candidate.shared);
  if (appVolumes.length > 0)
    yield* work(appVolumes).pipe(
      mapFailures((error) => {
        if (!(error instanceof StateStoreError)) return error;
        return new ProviderUnavailableError({
          providerId: runtime.ctx.providerId,
          operation: "bringDown.volume",
          message: `Could not acquire the volume locks: ${error.message}`,
          remediation: error.reason === "newer-version" ? error.remediation : runtime.ctx.remediation,
          cause: error,
        });
      }),
    );
  // Shared cache contention must not prevent app-volume cleanup or another cache's purge.
  for (const candidate of snapshot
    .filter((volume) => volume.shared)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    yield* work([candidate]).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          skipped.push(
            skippedVolume(
              candidate,
              error._tag === "StateStoreError" && error.lockFailure === "timeout"
                ? "in use"
                : "shared cache could not be safely removed",
            ),
          );
        }),
      ),
    );
  }
  return { volumesRemoved, retired, skipped };
});
