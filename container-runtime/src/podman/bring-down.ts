import { mapFailures } from "@lando/sdk/command-result";
import { type ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type ServiceShutdownObservation,
  type VolumeRemovalCounts,
  landoOwnedNetworkNames,
  volumesRemovedAny,
} from "@lando/sdk/schema";
import type { EventService, ProviderError } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

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
  listLabeledServiceContainers,
  removeStaleServiceContainers,
  selectStaleServiceContainers,
} from "./stale-service-containers.ts";
import { stopService } from "./stop-service.ts";

type EventPublisher = Pick<Context.Service.Shape<typeof EventService>, "publish">;
type BringDownError = ProviderUnavailableError | ProviderInternalError;

const DESTROY_REMEDIATION =
  "Run `lando doctor` to inspect the runtime, then `lando destroy` to retry cleanup. Use `--volumes` to remove app-scoped volumes.";

const GLOBAL_DESTROY_REMEDIATION =
  "Run `lando global:status` to inspect global services, then retry `lando global:stop`. If cleanup is still needed, run `lando global:destroy`; `--purge` also removes global service data volumes.";

interface StopResult {
  readonly changed: boolean;
  readonly shutdownObservations: readonly ServiceShutdownObservation[];
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
  readonly recordedPlan?: AppPlan | undefined;
  readonly adoptionReceipts?: readonly import("../data-root-ownership.ts").AdoptionReceipt[];
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

export const bringDown = Effect.fn("RuntimeProvider.bringDown")(function* (
  plan: AppPlan,
  options: BringDownOptions,
): Effect.fn.Return<StopResult, ProviderError> {
  const api = options.api;
  if (api === undefined) {
    return yield* Effect.fail(missingApi(options.ctx, "bringDown"));
  }
  if (api.request === undefined) {
    return yield* Effect.fail(missingApi(options.ctx, "bringDown"));
  }
  const deps: BringDownDeps = {
    api,
    options,
    remediation: plan.id === "global" ? GLOBAL_DESTROY_REMEDIATION : DESTROY_REMEDIATION,
  };

  let changed = false;
  const shutdownObservations: ServiceShutdownObservation[] = [];
  const stopCtx = { ...options.ctx, remediation: deps.remediation };
  const volumeRuntime = { ...options, ctx: stopCtx, request: api.request };
  const snapshot = yield* planVolumeDeletions(volumeRuntime, plan, options);
  // Whole-app stop shares stale-name selection with bring-up: list once, remove owned
  // plan-service containers whose native name is not the current planned name.
  const containers = yield* listLabeledServiceContainers(api, stopCtx, plan.id).pipe(
    mapFailures((error) => retainShutdownObservations(error, shutdownObservations)),
  );
  const stales = selectStaleServiceContainers(plan, options.ctx.providerId, containers, options.recordedPlan);
  const stale = yield* removeStaleServiceContainers(api, stopCtx, plan, stales).pipe(
    mapFailures((error) => retainShutdownObservations(error, shutdownObservations)),
  );
  changed = changed || stale.changed;
  shutdownObservations.push(...stale.shutdownObservations);
  const observedStale = new Set(stale.shutdownObservations.map((observation) => String(observation.service)));
  for (const service of Object.values(plan.services).reverse()) {
    const result = yield* stopService(plan, service, {
      ...options,
      api,
      ctx: stopCtx,
    }).pipe(mapFailures((error) => retainShutdownObservations(error, shutdownObservations)));
    changed = changed || result.changed;
    // The removed old-named container already reported this service; its absent planned name adds nothing.
    shutdownObservations.push(
      ...result.shutdownObservations.filter(
        (observation) =>
          !(observedStale.has(String(observation.service)) && observation.reason === "container-absent"),
      ),
    );
  }
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
    changed: changed || networkRemoved || volumesRemovedAny(volumesRemoved),
    shutdownObservations,
    volumesRemoved,
    ...(retained.length === 0 ? {} : { skipped: retained }),
  };
});
