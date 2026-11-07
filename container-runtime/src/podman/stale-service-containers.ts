import type { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServiceShutdownObservation,
  planAppIdentity,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import type { EngineHttpApi, ProviderErrorContext } from "../engine-api.ts";
import {
  APP_LABEL,
  APP_ROOT_LABEL,
  ROLE_LABEL,
  SCRATCH_ID_LABEL,
  SCRATCH_LABEL,
  SERVICE_LABEL,
  scratchLabelsForPlan,
} from "../labels.ts";
import { coherentContainerOwnership } from "../native-ownership.ts";
import { serviceContainerName } from "../plan.ts";
import { retainShutdownObservations, stopAndRemoveContainer } from "../stop-container.ts";
import { listLabeledContainerRows } from "./discover.ts";

/** One Lando-labeled container from the engine list endpoint, with native names. */
export type LabeledServiceContainer = {
  readonly id: string;
  readonly names: ReadonlyArray<string>;
  readonly labels: Readonly<Record<string, string>>;
};

/** A planned-service container whose native name is not the current planned name. */
export type StaleServiceContainer = {
  readonly containerId: string;
  readonly service: string;
  readonly name: string;
};

const stripName = (name: string): string => name.replace(/^\//u, "");

/** Lists this app's labeled containers in one call, keeping `Names` for stale-name selection. */
export const listLabeledServiceContainers = (
  api: EngineHttpApi | undefined,
  ctx: ProviderErrorContext,
  appId: string,
): Effect.Effect<ReadonlyArray<LabeledServiceContainer>, ProviderInternalError | ProviderUnavailableError> =>
  listLabeledContainerRows(api, ctx, [`${APP_LABEL}=${appId}`]).pipe(
    Effect.map((containers) =>
      containers.flatMap((container): ReadonlyArray<LabeledServiceContainer> => {
        if (container.Id.length === 0) return [];
        const labels = container.Labels ?? {};
        if (labels[APP_LABEL] === undefined) return [];
        return [
          {
            id: container.Id,
            names: (container.Names ?? []).map(stripName).filter((name) => name.length > 0),
            labels,
          },
        ];
      }),
    ),
  );

/**
 * Selects containers owned by this plan's services whose native name is not the current
 * serviceContainerName. Excludes role-labeled helpers and foreign ownership.
 */
export const selectStaleServiceContainers = (
  plan: AppPlan,
  providerId: string,
  containers: ReadonlyArray<LabeledServiceContainer>,
): ReadonlyArray<StaleServiceContainer> => {
  const root = String(planAppIdentity(plan).appRoot);
  const scratch = scratchLabelsForPlan(plan);
  const planned = new Map(
    Object.values(plan.services).map((service) => [
      String(service.name),
      serviceContainerName(plan, service.name),
    ]),
  );
  const selected: StaleServiceContainer[] = [];
  for (const container of containers) {
    const labels = container.labels;
    if (labels[ROLE_LABEL] !== undefined) continue;
    if (!coherentContainerOwnership(labels, providerId)) continue;
    if (labels[APP_LABEL] !== plan.id) continue;
    if (labels[APP_ROOT_LABEL] !== root) continue;
    // A scratch app and a user app can share a root and a slug; never remove the other kind's container.
    if (
      labels[SCRATCH_LABEL] !== scratch[SCRATCH_LABEL] ||
      labels[SCRATCH_ID_LABEL] !== scratch[SCRATCH_ID_LABEL]
    )
      continue;
    const service = labels[SERVICE_LABEL];
    if (service === undefined) continue;
    const expected = planned.get(service);
    if (expected === undefined) continue;
    const names = container.names.map(stripName).filter((name) => name.length > 0);
    const name = names[0];
    if (name === undefined || names.includes(expected)) continue;
    selected.push({
      containerId: container.id,
      service,
      name,
    });
  }
  return selected;
};

/**
 * Stops and removes each stale container by id. Removal uses force=true&v=true so only
 * anonymous volumes attached to that container are deleted. Returns the shutdown facts of the
 * removed containers so a teardown receipt keeps them.
 */
export const removeStaleServiceContainers = Effect.fn("RuntimeProvider.removeStaleServiceContainers")(
  function* (
    api: EngineHttpApi,
    ctx: ProviderErrorContext,
    plan: AppPlan,
    stales: ReadonlyArray<StaleServiceContainer>,
  ): Effect.fn.Return<
    { readonly changed: boolean; readonly shutdownObservations: ReadonlyArray<ServiceShutdownObservation> },
    ProviderInternalError | ProviderUnavailableError
  > {
    const providerId = ProviderId.make(ctx.providerId);
    let changed = false;
    const shutdownObservations: ServiceShutdownObservation[] = [];
    for (const stale of stales) {
      const result = yield* stopAndRemoveContainer(
        {
          appId: AppId.make(plan.id),
          providerId,
          service: ServiceName.make(stale.service),
          containerId: stale.containerId,
        },
        { api, ctx },
      ).pipe(Effect.mapError((error) => retainShutdownObservations(error, shutdownObservations)));
      changed = changed || result.changed;
      shutdownObservations.push(...result.shutdownObservations);
    }
    return { changed, shutdownObservations };
  },
);
