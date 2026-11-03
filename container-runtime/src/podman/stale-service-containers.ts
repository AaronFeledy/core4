import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AppId, type AppPlan, ProviderId, ServiceName, planAppIdentity } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import type { EngineHttpApi, ProviderErrorContext } from "../engine-api.ts";
import { engineApiFailure, missingApi, parseEngineJson } from "../engine-errors.ts";
import { APP_LABEL, APP_ROOT_LABEL, ROLE_LABEL, SERVICE_LABEL } from "../labels.ts";
import { coherentContainerOwnership } from "../native-ownership.ts";
import { serviceContainerName } from "../plan.ts";
import { redactResponseDetails, redactorFor, withApiReason } from "../redact.ts";
import { stopAndRemoveContainer } from "../stop-container.ts";

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

const Containers = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    Names: Schema.optionalKey(Schema.Array(Schema.String)),
    Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
);

const stripName = (name: string): string => name.replace(/^\//u, "");

/** Lists this app's labeled containers in one call, keeping `Names` for stale-name selection. */
export const listLabeledServiceContainers = Effect.fn("RuntimeProvider.listLabeledServiceContainers")(
  function* (
    api: EngineHttpApi | undefined,
    ctx: ProviderErrorContext,
    appId: string,
  ): Effect.fn.Return<
    ReadonlyArray<LabeledServiceContainer>,
    ProviderInternalError | ProviderUnavailableError
  > {
    const request = api?.request;
    if (request === undefined) {
      return yield* Effect.fail(
        missingApi(ctx, "list", `provider-${ctx.providerId} list requires an engine API client.`),
      );
    }
    const query = new URLSearchParams({
      all: "true",
      filters: JSON.stringify({ label: [`${APP_LABEL}=${appId}`] }),
    });
    const input = { method: "GET", path: `/containers/json?${query}` } as const;
    const response = yield* request(input).pipe(
      Effect.mapError((cause) => engineApiFailure(ctx, "list", input, cause)),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: ctx.providerId,
          operation: "list",
          message: withApiReason(
            `provider-${ctx.providerId} list failed with HTTP ${response.status}.`,
            response,
            redactorFor(ctx),
          ),
          details: redactResponseDetails(response, redactorFor(ctx)),
          remediation: ctx.remediation,
        }),
      );
    }
    const decoded = yield* parseEngineJson(response, ctx, "list");
    const containers = yield* Schema.decodeUnknownEffect(Containers)(decoded).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderInternalError({
            providerId: ctx.providerId,
            operation: "list",
            message: "Container engine returned an invalid container list.",
            remediation: ctx.remediation,
            cause,
          }),
      ),
    );
    return containers.flatMap((container): ReadonlyArray<LabeledServiceContainer> => {
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
    });
  },
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
 * anonymous volumes attached to that container are deleted.
 */
export const removeStaleServiceContainers = Effect.fn("RuntimeProvider.removeStaleServiceContainers")(
  function* (
    api: EngineHttpApi,
    ctx: ProviderErrorContext,
    plan: AppPlan,
    stales: ReadonlyArray<StaleServiceContainer>,
  ): Effect.fn.Return<boolean, ProviderInternalError | ProviderUnavailableError> {
    const providerId = ProviderId.make(ctx.providerId);
    let changed = false;
    for (const stale of stales) {
      const result = yield* stopAndRemoveContainer(
        {
          appId: AppId.make(plan.id),
          providerId,
          service: ServiceName.make(stale.service),
          containerId: stale.containerId,
        },
        { api, ctx },
      );
      changed = changed || result.changed;
    }
    return changed;
  },
);
