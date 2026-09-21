import { Context, Effect, Layer, Option } from "effect";

import { ScratchAppError } from "@lando/sdk/errors";
import { RuntimeProviderRegistry } from "@lando/sdk/services";

const SCRATCH_LABEL = "dev.lando.scratch";
const SCRATCH_ID_LABEL = "dev.lando.scratch-id";
const CANONICAL_SCRATCH_ID = /^scratch-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6}$/u;

export const isCanonicalScratchId = (id: string): boolean => CANONICAL_SCRATCH_ID.test(id);

const scratchIdFromLabels = (
  labels: Readonly<Record<string, string>> | undefined,
  appId?: string,
): string | undefined => {
  if (labels?.[SCRATCH_LABEL] !== "TRUE") return undefined;
  const id = labels[SCRATCH_ID_LABEL];
  if (id === undefined || !isCanonicalScratchId(id)) return undefined;
  if (appId !== undefined && appId !== id) return undefined;
  return id;
};

const scannerError = (operation: string, message: string, cause: unknown): ScratchAppError =>
  new ScratchAppError({ operation, message, cause });

export interface ScratchResourceScannerService {
  readonly listScratchIds: Effect.Effect<ReadonlyArray<string>, ScratchAppError>;
  readonly pruneScratch: (id: string) => Effect.Effect<void, ScratchAppError>;
}

export class ScratchResourceScanner extends Context.Tag("@lando/core/ScratchResourceScanner")<
  ScratchResourceScanner,
  ScratchResourceScannerService
>() {}

export const ScratchResourceScannerLive = Layer.effect(
  ScratchResourceScanner,
  Effect.gen(function* () {
    const registryOption = yield* Effect.serviceOption(RuntimeProviderRegistry);
    if (Option.isNone(registryOption)) {
      return {
        listScratchIds: Effect.succeed([]),
        pruneScratch: () => Effect.void,
      } satisfies ScratchResourceScannerService;
    }
    const registry = registryOption.value;

    const loadResources = () =>
      registry.select().pipe(
        Effect.flatMap((provider) =>
          Effect.all({
            services: provider.list({ includeScratch: true }),
            volumes: provider.listVolumes({ labels: { [SCRATCH_LABEL]: "TRUE" } }),
          }),
        ),
        Effect.mapError((cause) =>
          scannerError("gc", "Unable to list labeled scratch provider resources.", cause),
        ),
      );

    return {
      listScratchIds: loadResources().pipe(
        Effect.map(({ services, volumes }) => {
          const ids = new Set<string>();
          for (const service of services) {
            const id = scratchIdFromLabels(service.labels, String(service.app));
            if (id !== undefined) ids.add(id);
          }
          for (const volume of volumes) {
            const id = scratchIdFromLabels(volume.labels);
            if (id !== undefined) ids.add(id);
          }
          return [...ids].sort();
        }),
        Effect.catchAll(() => Effect.succeed([])),
      ),
      pruneScratch: (id) =>
        Effect.gen(function* () {
          if (!isCanonicalScratchId(id)) return;
          const { services, volumes } = yield* loadResources();
          const matchingVolumes = volumes.filter((volume) => scratchIdFromLabels(volume.labels) === id);
          if (matchingVolumes.some((volume) => volume.identity === undefined)) {
            return yield* Effect.fail(
              scannerError(
                "gc",
                `Scratch volume for ${id} is missing generation identity, so it cannot be pruned safely.`,
                undefined,
              ),
            );
          }
          const provider = yield* registry
            .select()
            .pipe(
              Effect.mapError((cause) =>
                scannerError("gc", `Unable to select a provider to prune scratch app ${id}.`, cause),
              ),
            );
          yield* Effect.forEach(
            services.filter((service) => scratchIdFromLabels(service.labels, String(service.app)) === id),
            (service) => provider.removeObservedService(service),
            { concurrency: "unbounded", discard: true },
          ).pipe(
            Effect.mapError((cause) =>
              scannerError("gc", `Unable to prune provider resources for scratch app ${id}.`, cause),
            ),
          );
          yield* Effect.forEach(
            matchingVolumes,
            (volume) =>
              volume.identity === undefined
                ? Effect.void
                : provider.removeVolume(volume.ref, volume.identity.generation),
            { concurrency: "unbounded", discard: true },
          ).pipe(
            Effect.mapError((cause) =>
              scannerError("gc", `Unable to prune provider resources for scratch app ${id}.`, cause),
            ),
          );
        }),
    } satisfies ScratchResourceScannerService;
  }),
);
