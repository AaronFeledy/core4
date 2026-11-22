import { orDieWithRole } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AbsolutePath,
  type AppId,
  LANDO_DATA_ROOT_LABEL,
  type OwnedResourcesCleanupResult,
  type ServiceName,
  noVolumesRemoved,
} from "@lando/sdk/schema";
import { type DestroyOptions, EventService, type ProviderError } from "@lando/sdk/services";
import { DateTime, Effect, Option, Schema } from "effect";
import { removeRuntimeContainer } from "./container-removal.ts";
import { dataRootRefusal, decideDataRootOwnership } from "./data-root-ownership.ts";
import type { EngineHttpRequest, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import { planInventoryVolumeDeletions } from "./inventory-volume-deletions.ts";
import {
  Observations,
  matchesPrivateNetworkLabels,
  privateNetworkLabels,
  serviceContainerOwnershipProblem,
} from "./native-ownership.ts";
import { type makeResourceOwnershipStore, ownershipFailure } from "./resource-ownership.ts";
import { PlanfulVolumeCoverage, deleteVolumeSnapshot } from "./teardown-volumes.ts";

export { privateNetworkLabels } from "./native-ownership.ts";

export const makeOwnedResourcesCleanup = (input: {
  readonly checkAppliedState?: (appId: AppId) => Effect.Effect<void, ProviderUnavailableError>;
  readonly store: ReturnType<typeof makeResourceOwnershipStore>;
  readonly api?: {
    readonly request?: (request: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, ProviderError>;
  };
  readonly ctx: ProviderErrorContext;
  readonly endpointNamespace?: string;
  readonly userDataRoot?: string | undefined;
}) =>
  Effect.fn("RuntimeProvider.cleanupOwnedResources")(function* (root: AbsolutePath, options: DestroyOptions) {
    const inventory = yield* input.store.load(root);
    const receipts = inventory?.adoptions?.flatMap((batch) => batch.receipts) ?? [];
    const servicesRemoved: ServiceName[] = [];
    const skipped: Array<{ appId: AppId; resource: string; reason: string }> = [];
    const events = yield* Effect.serviceOption(EventService);
    let networksRemoved = 0;
    const coverage = yield* PlanfulVolumeCoverage;
    const request = (request: EngineHttpRequest) =>
      input.api?.request === undefined
        ? Effect.fail(ownershipFailure(input.ctx.providerId))
        : input.api.request(request);
    const resources = [...(inventory?.resources ?? [])].sort((left, right) => {
      const order = { container: 0, network: 1, volume: 2 };
      return order[left.kind] - order[right.kind];
    });
    const volumeRuntime = { ...input, request };
    const { candidates, volumeRecords, refusal } = yield* planInventoryVolumeDeletions({
      root,
      resources,
      options,
      coverage,
      runtime: volumeRuntime,
      store: input.store,
      userDataRoot: input.userDataRoot,
      receipts,
      skipped,
      ...(input.checkAppliedState === undefined ? {} : { checkAppliedState: input.checkAppliedState }),
    });
    for (const resource of resources) {
      if (resource.kind === "volume") continue;
      if (options.appIds !== undefined && !options.appIds.includes(resource.appId)) continue;
      const readable = yield* (input.checkAppliedState?.(resource.appId) ?? Effect.void).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.operation === "applied-state.read",
          (error) =>
            Effect.gen(function* () {
              skipped.push({ appId: resource.appId, resource: resource.nativeName, reason: error.message });
              if (Option.isSome(events))
                yield* events.value
                  .publish({
                    _tag: "message.warn",
                    body: `Skipped ${resource.nativeName} for app ${resource.appId}: ${error.message}`,
                    timestamp: DateTime.nowUnsafe(),
                  })
                  .pipe(orDieWithRole("cleanup"));
              return false;
            }),
        ),
      );
      if (!readable) continue;
      const collection = resource.kind === "container" ? "containers" : "networks";
      const inspectPath: EngineHttpRequest["path"] = `/${collection}/${encodeURIComponent(resource.nativeName)}${resource.kind === "container" ? "/json" : ""}`;
      const inspected = yield* request({ method: "GET", path: inspectPath });
      if (inspected.status === 404) {
        yield* input.store.retire(root, resource);
        continue;
      }
      if (inspected.status !== 200) return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
      const decoded = Schema.decodeUnknownOption(Observations)(inspected.body);
      if (Option.isNone(decoded)) return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
      const observed = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
      if (observed === undefined) return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
      const labels = observed.Config?.Labels ?? observed.Labels ?? observed.labels ?? {};
      const dataOwner = labels[LANDO_DATA_ROOT_LABEL];
      const expectedOwner = input.userDataRoot ?? resource.dataRoot;
      const nativeId = observed.Id ?? observed.ID ?? observed.id;
      const native = { kind: resource.kind, nativeName: resource.nativeName, nativeId, labels };
      const containerProblem =
        resource.kind === "container"
          ? serviceContainerOwnershipProblem(labels, {
              app: String(resource.appId),
              appRoot: String(root),
              dataRoot: dataOwner,
              service: String(resource.service),
              providerId: input.ctx.providerId,
            })
          : undefined;
      const refusedContainer = (reason: string, details: Readonly<Record<string, string>>) =>
        new ProviderUnavailableError({
          providerId: input.ctx.providerId,
          operation: "resource-ownership",
          message: `Container ${resource.nativeName} is recorded for this app, but ${reason}, so Lando did not remove it.`,
          remediation: `Inspect container ${resource.nativeName} with your container runtime and remove it there if it is a leftover, then retry.`,
          details: { container: resource.nativeName, ...details },
        });
      if (
        expectedOwner === undefined
          ? dataOwner !== undefined
          : decideDataRootOwnership(native, { dataRoot: expectedOwner, receipts }) !== "owned"
      ) {
        return yield* new ProviderUnavailableError({
          providerId: input.ctx.providerId,
          operation: "resource-ownership",
          ...dataRootRefusal(native),
        });
      }
      if (resource.kind === "container" && containerProblem !== undefined)
        return yield* Effect.fail(
          refusedContainer(
            `its ${containerProblem} label does not prove it belongs to service ${resource.service} at ${root}`,
            { label: containerProblem },
          ),
        );
      if (resource.kind === "network") {
        const exactName = (observed.Name ?? observed.name) === resource.nativeName;
        const unscopedLabelFree =
          expectedOwner === undefined &&
          resource.role !== "authored" &&
          resource.scratchId === undefined &&
          exactName &&
          Object.keys(labels).length === 0;
        if (!unscopedLabelFree && !matchesPrivateNetworkLabels(labels, privateNetworkLabels(resource)))
          return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
      }
      if (!nativeId && resource.kind === "container")
        return yield* Effect.fail(refusedContainer("the runtime reported no native id for it", {}));
      if (!nativeId) return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
      const removed =
        resource.kind === "container"
          ? yield* removeRuntimeContainer({ request }, nativeId, {
              ...input.ctx,
              operation: "cleanupOwnedResources",
            })
          : yield* request({ method: "DELETE", path: `/${collection}/${encodeURIComponent(nativeId)}` }).pipe(
              Effect.flatMap((response) =>
                [200, 204, 404].includes(response.status)
                  ? Effect.succeed(response.status !== 404)
                  : Effect.fail(
                      new ProviderUnavailableError({
                        providerId: input.ctx.providerId,
                        operation: "cleanupOwnedResources",
                        message: "Verified resource removal failed.",
                        remediation: input.ctx.remediation,
                      }),
                    ),
              ),
            );
      yield* input.store.retire(root, resource);
      if (removed) {
        switch (resource.kind) {
          case "container":
            servicesRemoved.push(resource.service);
            break;
          case "network":
            networksRemoved += 1;
            break;
          default: {
            const unreachable: never = resource;
            return unreachable;
          }
        }
      }
    }
    if (refusal !== undefined) return yield* refusal;
    const removed =
      candidates.length === 0 ? undefined : yield* deleteVolumeSnapshot(volumeRuntime, candidates);
    if (removed !== undefined) {
      skipped.push(...removed.skipped);
      for (const resource of volumeRecords) {
        if (!removed.retired.has(resource.nativeName)) continue;
        const retire = input.store.retire(root, resource);
        if (resource.volumeScope === "global") yield* retire.pipe(Effect.catch(() => Effect.void));
        else yield* retire;
      }
    }
    return {
      servicesRemoved,
      networksRemoved,
      volumesRemoved: removed?.volumesRemoved ?? noVolumesRemoved,
      ...(skipped.length === 0 ? {} : { skipped }),
    } satisfies OwnedResourcesCleanupResult;
  });
