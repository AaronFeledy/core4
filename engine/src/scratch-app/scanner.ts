import { SCRATCH_ID_LABEL, SCRATCH_LABEL, VOLUME_INSTANCE_LABEL } from "@lando/container-runtime/labels";
import {
  adoptionReceiptsFromSummary,
  decideDataRootOwnership,
} from "@lando/container-runtime/native-ownership";
import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import { ScratchAppError } from "@lando/sdk/errors";
import { type AbsolutePath, LANDO_DATA_ROOT_LABEL, ProviderId } from "@lando/sdk/schema";
import { PathsService, RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { Context, Effect, Layer, Option } from "effect";
import { currentDataRoot } from "../operations/data-root-scope.ts";
import { runtimeOnline } from "../providers/runtime-observation.ts";
import { isCanonicalScratchId } from "./identity.ts";

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
  new ScratchAppError({
    operation,
    message,
    cause,
    remediation:
      causeRemediation(cause) ??
      "Run `lando doctor`, fix the provider runtime, then retry scratch resource cleanup.",
  });

export interface ScratchResourceScannerService {
  readonly listScratchIds: Effect.Effect<ReadonlyArray<string>, ScratchAppError>;
  readonly pruneScratch: (id: string) => Effect.Effect<void, ScratchAppError>;
  readonly prepareScratch: (
    id: string,
    keepVolumes: boolean,
  ) => Effect.Effect<
    {
      readonly stop: Effect.Effect<boolean, ScratchAppError>;
      readonly destroy: Effect.Effect<boolean, ScratchAppError>;
    },
    ScratchAppError
  >;
}

export class ScratchResourceScanner extends Context.Service<
  ScratchResourceScanner,
  ScratchResourceScannerService
>()("@lando/engine/ScratchResourceScanner") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const registryOption = yield* Effect.serviceOption(RuntimeProviderRegistry);
      const paths = yield* Effect.serviceOption(PathsService);
      if (Option.isNone(registryOption) || Option.isNone(paths)) {
        return ScratchResourceScanner.of({
          listScratchIds: Effect.succeed([]),
          pruneScratch: () => Effect.void,
          prepareScratch: () =>
            Effect.succeed({ stop: Effect.succeed(false), destroy: Effect.succeed(false) }),
        });
      }
      const registry = registryOption.value;
      const scopedRoot = yield* Effect.cached(
        currentDataRoot.pipe(Effect.provideService(PathsService, paths.value)),
      );
      const owns = Effect.fnUntraced(function* (target: {
        readonly provider: ProviderId;
        readonly appRoot?: AbsolutePath | undefined;
        readonly app: string;
        readonly native: Parameters<typeof decideDataRootOwnership>[0];
      }) {
        const dataRoot = yield* scopedRoot;
        const { native, appRoot, provider, app } = target;
        const summary =
          native.labels?.[LANDO_DATA_ROOT_LABEL] === undefined && appRoot !== undefined
            ? yield* registry.resourceOwnership?.(provider, appRoot) ?? Effect.succeed(undefined)
            : undefined;
        const receipts = adoptionReceiptsFromSummary(summary).filter(
          (receipt) =>
            receipt.appRoot === appRoot && receipt.providerId === provider && receipt.appId === app,
        );
        return decideDataRootOwnership(native, { dataRoot, receipts }) === "owned";
      });
      const listServices = (provider: RuntimeProviderShape) =>
        provider.list({ includeScratch: true, includeUnplanned: true }).pipe(
          Effect.flatMap((services) =>
            Effect.filter(services, (service) =>
              scratchIdFromLabels(service.labels, String(service.app)) === undefined
                ? Effect.succeed(false)
                : owns({
                    provider: service.providerId,
                    appRoot: service.appRoot,
                    app: service.app,
                    native: {
                      kind: "container",
                      nativeName: service.nativeName ?? "",
                      nativeId: service.containerId,
                      labels: service.labels,
                    },
                  }),
            ),
          ),
        );
      const listVolumes = (provider: RuntimeProviderShape) =>
        provider.listVolumes({ labels: { [SCRATCH_LABEL]: "TRUE" } }).pipe(
          Effect.flatMap((volumes) =>
            Effect.filter(volumes, (volume) =>
              scratchIdFromLabels(volume.labels) === undefined
                ? Effect.succeed(false)
                : owns({
                    provider: ProviderId.make(provider.id),
                    appRoot: volume.identity?.ownerRoot,
                    app: volume.ref.app,
                    native: {
                      kind: "volume",
                      nativeName: volume.identity?.nativeName ?? volume.ref.store,
                      volumeInstance: volume.labels?.[VOLUME_INSTANCE_LABEL],
                      labels: volume.labels,
                    },
                  }),
            ),
          ),
        );

      const loadResources = Effect.fn("ScratchResourceScanner.loadResources")(
        function* () {
          const ids = yield* registry.list;
          return yield* Effect.forEach(
            [...new Set(ids)],
            (id) =>
              Effect.gen(function* () {
                const provider = yield* registry.select(id).pipe(
                  Effect.flatMap((selected) =>
                    runtimeOnline(selected).pipe(Effect.map((online) => (online ? selected : undefined))),
                  ),
                  Effect.catchTag("ProviderUnavailableError", () => Effect.succeed(undefined)),
                );
                if (provider === undefined) return [];
                const resources = yield* Effect.all(
                  {
                    services: listServices(provider),
                    volumes: listVolumes(provider),
                  },
                  { concurrency: "unbounded" },
                );
                return [{ provider, ...resources }];
              }),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((observations) => observations.flat()));
        },
        mapFailures((cause) =>
          scannerError("gc", "Unable to list labeled scratch provider resources.", cause),
        ),
      );

      const prepareScratch = Effect.fn("ScratchResourceScanner.prepareScratch")(function* (
        id: string,
        keepVolumes: boolean,
      ) {
        if (!isCanonicalScratchId(id)) return { stop: Effect.succeed(false), destroy: Effect.succeed(false) };
        const observations = yield* loadResources();
        const matches = yield* Effect.forEach(observations, ({ provider, services, volumes }) =>
          Effect.forEach(
            volumes.filter((volume) => !keepVolumes && scratchIdFromLabels(volume.labels) === id),
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
        const stop = Effect.forEach(
          matches,
          ({ provider, services }) =>
            services.length === 0
              ? Effect.succeed([])
              : listServices(provider).pipe(
                  Effect.flatMap((fresh) =>
                    Effect.forEach(
                      fresh.filter(
                        (service) =>
                          service.containerId !== undefined &&
                          service.app === id &&
                          services.some((candidate) => candidate.containerId === service.containerId),
                      ),
                      (service) => provider.bringDownObserved(service, "remove"),
                      { concurrency: "unbounded" },
                    ),
                  ),
                ),
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map((results) => results.flat().some((result) => result.action === "removed")),
          mapFailures((cause) =>
            scannerError("gc", `Unable to prune provider resources for scratch app ${id}.`, cause),
          ),
        );
        const destroy = Effect.forEach(
          uniqueVolumes,
          ({ provider, ref, identity }) =>
            listVolumes(provider).pipe(
              Effect.flatMap((fresh) =>
                fresh.some(
                  (volume) =>
                    scratchIdFromLabels(volume.labels) === id &&
                    volume.ref.app === ref.app &&
                    volume.ref.store === ref.store &&
                    volume.ref.scope === ref.scope &&
                    volume.identity?.coordinationKey === identity.coordinationKey &&
                    volume.identity.generation === identity.generation,
                )
                  ? provider.removeVolume(ref, identity.generation).pipe(Effect.as(true))
                  : Effect.succeed(false),
              ),
            ),
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map((removed) => removed.some(Boolean)),
          mapFailures((cause) => scannerError("gc", `Unable to prune volumes for scratch app ${id}.`, cause)),
        );
        return { stop, destroy };
      });
      return ScratchResourceScanner.of({
        prepareScratch,
        pruneScratch: Effect.fn("ScratchResourceScanner.pruneScratch")(function* (id) {
          const prepared = yield* prepareScratch(id, false);
          yield* prepared.stop;
          yield* prepared.destroy;
        }),
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
      });
    }),
  );
}
