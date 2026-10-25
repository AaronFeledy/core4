import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AbsolutePath, OwnedResourcesCleanupResult, ServiceName } from "@lando/sdk/schema";
import type { DestroyOptions, ProviderError } from "@lando/sdk/services";
import { Effect, Option, Schema } from "effect";
import { removeRuntimeContainer } from "./container-removal.ts";
import type { EngineHttpRequest, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import { Observations, networkLabelsDecision, privateNetworkLabels } from "./native-ownership.ts";
import { volumeSelectorValue } from "./podman/volume-prune.ts";
import { type makeResourceOwnershipStore, ownershipFailure } from "./resource-ownership.ts";
import { VOLUME_OWNER_LABEL, VOLUME_SELECTOR_LABEL } from "./volume-ownership.ts";

export { privateNetworkLabels } from "./native-ownership.ts";

export const makeOwnedResourcesCleanup = (input: {
  readonly store: ReturnType<typeof makeResourceOwnershipStore>;
  readonly api?: {
    readonly request?: (request: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, ProviderError>;
  };
  readonly ctx: ProviderErrorContext;
}) =>
  Effect.fn("RuntimeProvider.cleanupOwnedResources")(function* (root: AbsolutePath, options: DestroyOptions) {
    const inventory = yield* input.store.load(root);
    const servicesRemoved: ServiceName[] = [];
    let networksRemoved = 0;
    let volumesRemoved = 0;
    const request = (request: EngineHttpRequest) =>
      input.api?.request === undefined
        ? Effect.fail(ownershipFailure(input.ctx.providerId))
        : input.api.request(request);
    const resources = [...(inventory?.resources ?? [])].sort((left, right) => {
      const order = { container: 0, network: 1, volume: 2 };
      return order[left.kind] - order[right.kind];
    });
    for (const resource of resources) {
      if (options.appIds !== undefined && !options.appIds.includes(resource.appId)) continue;
      if (
        resource.kind === "volume" &&
        !(resource.volumeClass === "cache"
          ? options.purgeCaches === true
          : resource.volumeScope !== "global" && options.volumes)
      )
        continue;
      const collection =
        resource.kind === "container" ? "containers" : resource.kind === "network" ? "networks" : "volumes";
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
      let expected: Readonly<Record<string, string>>;
      switch (resource.kind) {
        case "container":
          expected = {
            "dev.lando.app": resource.appId,
            "dev.lando.app-root": root,
            "dev.lando.service": resource.service,
          };
          break;
        case "network":
          expected = privateNetworkLabels(resource);
          break;
        case "volume":
          expected = {
            "dev.lando.app": resource.appId,
            [VOLUME_OWNER_LABEL]: root,
            [VOLUME_SELECTOR_LABEL]: volumeSelectorValue({
              providerId: resource.providerId,
              appId: resource.appId,
              ownerKey: resource.ownerKey,
              volumeClass: resource.volumeClass,
            }),
            "dev.lando.scope": resource.volumeScope,
          };
          break;
        default: {
          const unreachable: never = resource;
          return unreachable;
        }
      }
      if (
        resource.kind === "network"
          ? networkLabelsDecision(labels, expected) === "foreign"
          : Object.entries(expected).some(([key, value]) => labels[key] !== value)
      )
        return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
      if (
        resource.kind === "network" &&
        networkLabelsDecision(labels, expected) === "legacy" &&
        (observed.Name ?? observed.name) !== resource.nativeName
      )
        return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
      const nativeId =
        resource.kind === "volume" ? observed.Name : (observed.Id ?? observed.ID ?? observed.id);
      if (!nativeId || (resource.kind === "volume" && nativeId !== resource.nativeName))
        return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
      if (resource.kind === "volume") {
        const generation = labels["dev.lando.volume-instance"];
        if (!generation) return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
        const fresh = yield* request({ method: "GET", path: inspectPath });
        if (fresh.status === 404) {
          yield* input.store.retire(root, resource);
          continue;
        }
        const decodedFresh = Schema.decodeUnknownOption(Observations)(fresh.body);
        if (fresh.status !== 200 || Option.isNone(decodedFresh))
          return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
        const freshVolume = Array.isArray(decodedFresh.value) ? decodedFresh.value[0] : decodedFresh.value;
        const freshLabels = freshVolume?.Labels ?? freshVolume?.labels ?? {};
        if (
          freshVolume?.Name !== nativeId ||
          freshLabels["dev.lando.volume-instance"] !== generation ||
          Object.entries(expected).some(([key, value]) => freshLabels[key] !== value)
        )
          return yield* Effect.fail(ownershipFailure(input.ctx.providerId));
      }
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
          case "volume":
            volumesRemoved += 1;
            break;
          default: {
            const unreachable: never = resource;
            return unreachable;
          }
        }
      }
    }
    return { servicesRemoved, networksRemoved, volumesRemoved } satisfies OwnedResourcesCleanupResult;
  });
