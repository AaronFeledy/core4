import { SCRATCH_ID_LABEL, SCRATCH_LABEL } from "@lando/container-runtime/labels";
import { Context, Effect, Layer, Option } from "effect";

import { ScratchAppError } from "@lando/sdk/errors";
import { RuntimeProviderRegistry } from "@lando/sdk/services";

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

export class ScratchResourceScanner extends Context.Service<
  ScratchResourceScanner,
  ScratchResourceScannerService
>()("@lando/engine/ScratchResourceScanner") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const registryOption = yield* Effect.serviceOption(RuntimeProviderRegistry);
      if (Option.isNone(registryOption)) {
        return ScratchResourceScanner.of({
          listScratchIds: Effect.succeed([]),
          pruneScratch: () => Effect.void,
        });
      }
      const registry = registryOption.value;

      const loadResources = Effect.fn("ScratchResourceScanner.loadResources")(
        function* () {
          const ids = yield* registry.list;
          return yield* Effect.forEach(
            [...new Set(ids)],
            (id) =>
              Effect.gen(function* () {
                const provider = yield* registry.select(id).pipe(
                  Effect.flatMap((selected) =>
                    Effect.gen(function* () {
                      if (!(yield* selected.isAvailable)) return undefined;
                      return (yield* selected.getStatus).running ? selected : undefined;
                    }),
                  ),
                  Effect.catchTag("ProviderUnavailableError", () => Effect.succeed(undefined)),
                );
                if (provider === undefined) return [];
                const resources = yield* Effect.all(
                  {
                    services: provider.list({ includeScratch: true, includeUnplanned: true }),
                    volumes: provider.listVolumes({ labels: { [SCRATCH_LABEL]: "TRUE" } }),
                  },
                  { concurrency: "unbounded" },
                );
                return [{ provider, ...resources }];
              }),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((observations) => observations.flat()));
        },
        Effect.mapError((cause) =>
          scannerError("gc", "Unable to list labeled scratch provider resources.", cause),
        ),
      );

      return ScratchResourceScanner.of({
        listScratchIds: loadResources().pipe(
          Effect.map((observations) => {
            const ids = new Set<string>();
            for (const { services, volumes } of observations) {
              for (const service of services) {
                const id = scratchIdFromLabels(service.labels, String(service.app));
                if (id !== undefined) ids.add(id);
              }
              for (const volume of volumes) {
                const id = scratchIdFromLabels(volume.labels);
                if (id !== undefined) ids.add(id);
              }
            }
            return [...ids].sort();
          }),
        ),
        pruneScratch: Effect.fn("ScratchResourceScanner.pruneScratch")(function* (id) {
          if (!isCanonicalScratchId(id)) return;
          const observations = yield* loadResources();
          const matches = yield* Effect.forEach(observations, ({ provider, services, volumes }) =>
            Effect.forEach(
              volumes.filter((volume) => scratchIdFromLabels(volume.labels) === id),
              (volume) => {
                const identity = volume.identity;
                return identity === undefined
                  ? Effect.fail(
                      scannerError(
                        "gc",
                        `Scratch volume for ${id} is missing generation identity, so it cannot be pruned safely.`,
                        undefined,
                      ),
                    )
                  : Effect.succeed({ ref: volume.ref, identity });
              },
            ).pipe(
              Effect.map((validatedVolumes) => ({
                provider,
                services: services.filter(
                  (service) => scratchIdFromLabels(service.labels, String(service.app)) === id,
                ),
                volumes: validatedVolumes,
              })),
            ),
          );
          const seenVolumes = new Set<string>();
          const uniqueVolumes = matches.flatMap(({ provider, volumes }) =>
            volumes.flatMap((volume) => {
              const key = JSON.stringify([volume.identity.coordinationKey, volume.identity.generation]);
              if (seenVolumes.has(key)) return [];
              seenVolumes.add(key);
              return [{ provider, ...volume }];
            }),
          );
          yield* Effect.forEach(
            matches,
            ({ provider, services }) =>
              Effect.forEach(services, (service) => provider.removeObservedService(service), {
                concurrency: "unbounded",
                discard: true,
              }),
            { concurrency: "unbounded", discard: true },
          ).pipe(
            Effect.andThen(
              Effect.forEach(
                uniqueVolumes,
                ({ provider, ref, identity }) => provider.removeVolume(ref, identity.generation),
                { concurrency: "unbounded", discard: true },
              ),
            ),
            Effect.mapError((cause) =>
              scannerError("gc", `Unable to prune provider resources for scratch app ${id}.`, cause),
            ),
          );
        }),
      });
    }),
  );
}
