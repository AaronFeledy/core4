import { mapFailures } from "@lando/sdk/command-result";
import { type ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type ContainerBringDownReceipt,
  type ContainerDisposition,
  type ServiceShutdownObservation,
  type VolumeRemovalCounts,
  landoOwnedNetworkNames,
  volumesRemovedAny,
} from "@lando/sdk/schema";
import type { EventService, ProviderError } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

import type { AdoptionReceipt } from "../data-root-ownership.ts";
import type { LifecycleDialect } from "../dialect.ts";
import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi } from "../engine-errors.ts";
import type { HelperReclaimOptions } from "../helper-owner.ts";
import { inspectOwnedNativeId, isSharedNetwork, networkOwnershipLabels } from "../native-ownership.ts";
import { redactDetails, redactorFor, withApiReason } from "../redact.ts";
import { retainShutdownObservations } from "../stop-container.ts";
import { type SkippedVolume, deleteVolumeSnapshot } from "../teardown-volumes.ts";
import { planVolumeDeletions } from "./plan-volume-deletions.ts";
import {
  bringDownStaleServiceContainers,
  listLabeledServiceContainers,
  selectStaleServiceContainers,
} from "./stale-service-containers.ts";
import { stopService } from "./stop-service.ts";

type EventPublisher = Pick<Context.Service.Shape<typeof EventService>, "publish">;
type BringDownError = ProviderUnavailableError | ProviderInternalError;

const DESTROY_REMEDIATION =
  "Run `lando doctor` to inspect the runtime, then `lando destroy` to retry cleanup. Use `--volumes` to remove app-scoped volumes.";

const GLOBAL_DESTROY_REMEDIATION =
  "Run `lando global:status` to inspect global services, then retry `lando global:stop`. If cleanup is still needed, run `lando global:destroy`; `--purge` also removes global service data volumes.";

const STOP_REMEDIATION = "Run `lando doctor` to inspect the runtime, then retry `lando stop`.";

const GLOBAL_STOP_REMEDIATION =
  "Run `lando global:status` to inspect global services, then retry `lando global:stop`.";

interface ContainersResult {
  readonly changed: boolean;
  readonly receipts: readonly ContainerBringDownReceipt[];
  readonly shutdownObservations: readonly ServiceShutdownObservation[];
}

interface RemoveResult extends ContainersResult {
  readonly volumesRemoved: VolumeRemovalCounts;
  readonly skipped?: readonly SkippedVolume[];
}

export interface BringDownOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly endpointNamespace?: string;
  readonly dialect?: LifecycleDialect;
  readonly eventService?: EventPublisher;
  readonly volumes?: boolean;
  /** Test seam for owner-aware helper reclamation. */
  readonly helperReclaim?: HelperReclaimOptions;
  readonly purgeCaches?: boolean;
  readonly adoptionReceipts?: readonly AdoptionReceipt[];
}

interface BringDownDeps {
  readonly api: EngineHttpApi;
  readonly options: BringDownOptions;
  readonly remediation: string;
}

const request = (
  deps: BringDownDeps,
  input: EngineHttpRequest,
): Effect.Effect<EngineHttpResponse, BringDownError> =>
  deps.api.request === undefined
    ? Effect.fail(missingApi(deps.options.ctx, "bringDown"))
    : deps.api.request(input);

const podmanFailure = (deps: BringDownDeps, operation: string, message: string, details?: unknown) =>
  new ProviderUnavailableError({
    providerId: deps.options.ctx.providerId,
    operation,
    message: withApiReason(message, details, redactorFor(deps.options.ctx)),
    remediation: deps.remediation,
    ...(details === undefined ? {} : { details: redactDetails(details, redactorFor(deps.options.ctx)) }),
  });

const removeNetwork = Effect.fnUntraced(function* (
  deps: BringDownDeps,
  plan: AppPlan,
  name: string,
): Effect.fn.Return<boolean, BringDownError> {
  if (isSharedNetwork(plan, name)) return false;
  const id = yield* inspectOwnedNativeId(
    deps.api,
    {
      kind: "network",
      name,
      labels: networkOwnershipLabels(plan),
      receipts: deps.options.adoptionReceipts ?? [],
      legacy:
        plan.identity?.dataRoot !== undefined ||
        plan.networking?.authoredNetworks?.some((network) => network.name === name)
          ? "reject"
          : "accept",
    },
    deps.options.ctx,
  );
  if (id === undefined) return false;
  return yield* request(deps, { method: "DELETE", path: `/networks/${encodeURIComponent(id)}` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 200 || response.status === 204) {
        return Effect.succeed(true);
      }
      if (response.status === 404) {
        return Effect.succeed(false);
      }
      return Effect.fail(
        podmanFailure(
          deps,
          "bringDown.network",
          `provider-${deps.options.ctx.providerId} network remove failed with HTTP ${response.status}.`,
          { name, body: response.body },
        ),
      );
    }),
  );
});

/**
 * Brings down every container this plan's services own: owned containers still carrying an earlier
 * name first, then each planned name inspected with the adoption receipts. Stale selection excludes
 * a container that carries its planned name, and receipts are deduplicated by native id, so no
 * container is reported twice.
 */
const bringDownServiceContainers = Effect.fnUntraced(function* (
  plan: AppPlan,
  disposition: ContainerDisposition,
  input: {
    readonly api: EngineHttpApi;
    readonly ctx: ProviderErrorContext;
    readonly options: BringDownOptions;
  },
): Effect.fn.Return<ContainersResult, ProviderError> {
  const { api, ctx, options } = input;
  const shutdownObservations: ServiceShutdownObservation[] = [];
  const containers = yield* listLabeledServiceContainers(api, ctx, plan.id);
  const stales = selectStaleServiceContainers(plan, ctx.providerId, containers, options.adoptionReceipts);
  const stale = yield* bringDownStaleServiceContainers(api, ctx, plan, { containers: stales, disposition });
  let changed = stale.changed;
  const receipts: ContainerBringDownReceipt[] = [...stale.receipts];
  const seen = new Set(stale.receipts.flatMap((receipt) => receipt.containerId ?? []));
  shutdownObservations.push(...stale.shutdownObservations);
  const observedStale = new Set(stale.receipts.map((receipt) => String(receipt.service)));
  for (const service of Object.values(plan.services).reverse()) {
    const result = yield* stopService(plan, service, { ...options, containers: disposition, api, ctx }).pipe(
      mapFailures((error) => retainShutdownObservations(error, shutdownObservations)),
    );
    changed = changed || result.changed;
    if (result.containerId !== undefined && seen.has(result.containerId)) continue;
    // The old-named container already reported this service; its absent planned name adds nothing.
    const reportedStale = observedStale.has(String(service.name));
    shutdownObservations.push(
      ...result.shutdownObservations.filter(
        (observation) => !(reportedStale && observation.reason === "container-absent"),
      ),
    );
    if (result.containerId === undefined) {
      if (!reportedStale) receipts.push({ service: service.name, action: result.action });
      continue;
    }
    seen.add(result.containerId);
    receipts.push({ service: service.name, containerId: result.containerId, action: result.action });
  }
  return { changed, receipts, shutdownObservations };
});

const requireApi = (
  options: BringDownOptions,
): Effect.Effect<
  { readonly api: EngineHttpApi; readonly request: NonNullable<EngineHttpApi["request"]> },
  ProviderUnavailableError
> => {
  const api = options.api;
  const request = api?.request;
  return api === undefined || request === undefined
    ? Effect.fail(missingApi(options.ctx, "bringDown"))
    : Effect.succeed({ api, request });
};

/**
 * Stops every container this plan's services own and keeps each one. Networks, volumes, and applied
 * state are never touched, so the containers stay available to the next apply.
 */
export const stopAppContainers = Effect.fn("RuntimeProvider.stopAppContainers")(function* (
  plan: AppPlan,
  options: BringDownOptions,
): Effect.fn.Return<ContainersResult, ProviderError> {
  const { api } = yield* requireApi(options);
  const ctx = {
    ...options.ctx,
    remediation: plan.id === "global" ? GLOBAL_STOP_REMEDIATION : STOP_REMEDIATION,
  };
  return yield* bringDownServiceContainers(plan, "stop", { api, ctx, options });
});

/** Removes every container this plan's services own, then its networks and volumes as requested. */
export const bringDown = Effect.fn("RuntimeProvider.bringDown")(function* (
  plan: AppPlan,
  options: BringDownOptions,
): Effect.fn.Return<RemoveResult, ProviderError> {
  const { api, request } = yield* requireApi(options);
  const deps: BringDownDeps = {
    api,
    options,
    remediation: plan.id === "global" ? GLOBAL_DESTROY_REMEDIATION : DESTROY_REMEDIATION,
  };

  const stopCtx = { ...options.ctx, remediation: deps.remediation };
  const volumeRuntime = { ...options, ctx: stopCtx, request };
  const snapshot = yield* planVolumeDeletions(volumeRuntime, plan, options);
  const containers = yield* bringDownServiceContainers(plan, "remove", { api, ctx: stopCtx, options });
  const shutdownObservations = containers.shutdownObservations;
  let networkRemoved = false;
  for (const name of landoOwnedNetworkNames(plan)) {
    const authored = plan.networking?.authoredNetworks?.find((network) => network.name === name);
    if (authored !== undefined && Object.keys(authored.members).some((member) => !(member in plan.services)))
      continue;
    const removed = yield* removeNetwork(deps, plan, name).pipe(
      mapFailures((error) => retainShutdownObservations(error, shutdownObservations)),
    );
    networkRemoved = networkRemoved || removed;
  }
  const { volumesRemoved, skipped } = yield* deleteVolumeSnapshot(volumeRuntime, snapshot.candidates).pipe(
    mapFailures((error) =>
      error._tag === "ProviderUnavailableError" || error._tag === "ProviderInternalError"
        ? retainShutdownObservations(error, shutdownObservations)
        : error,
    ),
  );
  const retained = [...snapshot.skipped, ...skipped];

  return {
    changed: containers.changed || networkRemoved || volumesRemovedAny(volumesRemoved),
    receipts: containers.receipts,
    shutdownObservations,
    volumesRemoved,
    ...(retained.length === 0 ? {} : { skipped: retained }),
  };
});
