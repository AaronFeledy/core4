import { type Context, DateTime, Effect } from "effect";
import { serviceContainerName } from "../plan.ts";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { PostServiceStopEvent, PreServiceStopEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type AppRef,
  ProviderId,
  type ServicePlan,
  landoOwnedNetworkNames,
} from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

import { removeRuntimeContainer } from "../container-removal.ts";
import { type LifecycleDialect, libpodLifecycleDialect } from "../dialect.ts";
import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi } from "../engine-errors.ts";
import { parseJsonOrUndefined } from "../engine-json.ts";
import {
  isVolumeInUse,
  listVolumeHolders,
  volumeInUseMessage,
  volumeInUseRemediation,
} from "../ephemeral-data-helpers.ts";
import {
  containerOwnershipLabels,
  inspectOwnedNativeId,
  isSharedNetwork,
  networkOwnershipLabels,
} from "../native-ownership.ts";
import { redactDetails, redactorFor, withApiReason } from "../redact.ts";
import { teardownVolumeClasses, volumeClassForStore } from "../volume-classes.ts";
import { planVolumeFilters } from "../volume-ownership.ts";
import { pruneVolumes, volumeMatchesFilters } from "./volume-prune.ts";

type EventPublisher = Pick<Context.Service.Shape<typeof EventService>, "publish">;
type BringDownError = ProviderUnavailableError | ProviderInternalError;

const DESTROY_REMEDIATION =
  "Run `lando doctor` to inspect the runtime, then `lando destroy` to retry cleanup. Use `--volumes` to remove app-scoped volumes.";

const GLOBAL_DESTROY_REMEDIATION =
  "Run `lando global:status` to inspect global services, then retry `lando global:stop`. If cleanup is still needed, run `lando global:destroy`; `--purge` also removes global service data volumes.";

interface StopResult {
  readonly changed: boolean;
}

export interface BringDownOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly dialect?: LifecycleDialect;
  readonly eventService?: EventPublisher;
  readonly volumes?: boolean;
  readonly purgeCaches?: boolean;
}

interface BringDownDeps {
  readonly api: EngineHttpApi;
  readonly options: BringDownOptions;
  readonly remediation: string;
}

const appRef = (plan: AppPlan): AppRef => ({
  kind: "user",
  id: plan.id,
  root: plan.root,
});

const containerName = (plan: AppPlan, service: ServicePlan) => serviceContainerName(plan, service.name);

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

const publish = (
  deps: BringDownDeps,
  event: Parameters<EventPublisher["publish"]>[0],
): Effect.Effect<void, ProviderInternalError> =>
  deps.options.eventService === undefined
    ? Effect.void
    : deps.options.eventService.publish(event).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderInternalError({
              providerId: deps.options.ctx.providerId,
              operation: "bringDown.event",
              message: `Failed to publish lifecycle event: ${event._tag}`,
              remediation: deps.remediation,
              cause,
            }),
        ),
      );

const stopContainer = (deps: BringDownDeps, name: string): Effect.Effect<boolean, BringDownError> =>
  request(deps, { method: "POST", path: `/containers/${encodeURIComponent(name)}/stop` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 204) {
        return Effect.succeed(true);
      }
      if (response.status === 304 || response.status === 404) {
        return Effect.succeed(false);
      }
      return Effect.fail(
        podmanFailure(
          deps,
          "bringDown.stop",
          `provider-${deps.options.ctx.providerId} container stop failed with HTTP ${response.status}.`,
          { name, body: response.body },
        ),
      );
    }),
  );

const removeContainer = (deps: BringDownDeps, name: string): Effect.Effect<boolean, BringDownError> =>
  removeRuntimeContainer(deps.api, name, {
    ...deps.options.ctx,
    remediation: deps.remediation,
    operation: "bringDown.remove",
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
      legacy: plan.networking?.authoredNetworks?.some((network) => network.name === name)
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

const parseVolumeLabels = (body: string): Readonly<Record<string, string>> | undefined => {
  const parsed = parseJsonOrUndefined(body);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = Reflect.get(parsed, "Labels");
  if (typeof value !== "object" || value === null) return undefined;
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label === "string") labels[key] = label;
  }
  return labels;
};

const removeVolume = Effect.fnUntraced(function* (
  deps: BringDownDeps,
  plan: AppPlan,
  store: AppPlan["stores"][number],
): Effect.fn.Return<boolean, BringDownError> {
  const name = store.name;
  const inspected = yield* request(deps, {
    method: "GET",
    path: `/volumes/${encodeURIComponent(name)}`,
  });
  if (inspected.status === 404) return false;
  if (inspected.status !== 200) {
    return yield* Effect.fail(
      podmanFailure(
        deps,
        "bringDown.volume.inspect",
        `provider-${deps.options.ctx.providerId} volume inspect failed with HTTP ${inspected.status}.`,
        { name, body: inspected.body },
      ),
    );
  }
  const labels = parseVolumeLabels(inspected.body);
  const volumeClass = volumeClassForStore(store);
  if (labels === undefined || !volumeMatchesFilters(labels, planVolumeFilters(plan, [volumeClass]))) {
    return false;
  }
  const response = yield* request(deps, {
    method: "DELETE",
    path: `/volumes/${encodeURIComponent(name)}`,
  });
  if (response.status === 200 || response.status === 204) return true;
  if (response.status === 404) return false;
  if (isVolumeInUse(response)) {
    const redactor = redactorFor(deps.options.ctx);
    const holders = deps.api.request === undefined ? [] : yield* listVolumeHolders(deps.api.request, name);
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: deps.options.ctx.providerId,
        operation: "bringDown.volume",
        message: volumeInUseMessage(
          `provider-${deps.options.ctx.providerId} volume remove failed with HTTP ${response.status}.`,
          holders,
          response,
          redactor,
        ),
        remediation: volumeInUseRemediation(redactor),
        details: redactDetails({ name, body: response.body, status: response.status }, redactor),
      }),
    );
  }
  return yield* Effect.fail(
    podmanFailure(
      deps,
      "bringDown.volume",
      `provider-${deps.options.ctx.providerId} volume remove failed with HTTP ${response.status}.`,
      { name, body: response.body },
    ),
  );
});

const removeAppScopedVolumes = Effect.fnUntraced(function* (
  deps: BringDownDeps,
  plan: AppPlan,
): Effect.fn.Return<boolean, BringDownError> {
  let changed = false;
  for (const store of plan.stores) {
    if (store.kind === "cache") {
      if (deps.options.purgeCaches !== true) continue;
    } else if (store.scope === "global" || deps.options.volumes !== true) {
      continue;
    }
    const removed = yield* removeVolume(deps, plan, store);
    changed = changed || removed;
  }
  return changed;
});

const pruneAppScopedVolumes = (deps: BringDownDeps, plan: AppPlan): Effect.Effect<boolean, BringDownError> =>
  pruneVolumes(deps.api, {
    filters: planVolumeFilters(plan, teardownVolumeClasses(deps.options)),
    ctx: deps.options.ctx,
    all: deps.options.volumes === true,
  }).pipe(Effect.map((report) => report.pruned.length > 0 || report.errors.length > 0));

const stopService = Effect.fnUntraced(function* (
  deps: BringDownDeps,
  plan: AppPlan,
  service: ServicePlan,
): Effect.fn.Return<StopResult, BringDownError> {
  const name = containerName(plan, service);
  const providerId = ProviderId.make(deps.options.ctx.providerId);

  yield* publish(
    deps,
    PreServiceStopEvent.make({
      eventName: "pre-service-stop",
      appRef: appRef(plan),
      serviceName: service.name,
      providerId,
      timestamp: yield* DateTime.now,
    }),
  );

  const id = yield* inspectOwnedNativeId(
    deps.api,
    { kind: "container", name, labels: containerOwnershipLabels(plan, service.name) },
    deps.options.ctx,
  );
  const stopped = id === undefined ? false : yield* stopContainer(deps, id);
  const removed = id === undefined ? false : yield* removeContainer(deps, id);

  yield* publish(
    deps,
    PostServiceStopEvent.make({
      eventName: "post-service-stop",
      appRef: appRef(plan),
      serviceName: service.name,
      providerId,
      timestamp: yield* DateTime.now,
    }),
  );

  return { changed: stopped || removed };
});

export const bringDown = Effect.fn("RuntimeProvider.bringDown")(function* (
  plan: AppPlan,
  options: BringDownOptions,
): Effect.fn.Return<StopResult, BringDownError> {
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
  for (const service of Object.values(plan.services).reverse()) {
    const result = yield* stopService(deps, plan, service);
    changed = changed || result.changed;
  }
  let networkRemoved = false;
  for (const name of landoOwnedNetworkNames(plan)) {
    const authored = plan.networking?.authoredNetworks?.find((network) => network.name === name);
    if (authored !== undefined && Object.keys(authored.members).some((member) => !(member in plan.services)))
      continue;
    const removed = yield* removeNetwork(deps, plan, name);
    networkRemoved = networkRemoved || removed;
  }
  let volumesRemoved = false;
  if (options.volumes === true || options.purgeCaches === true) {
    volumesRemoved = yield* removeAppScopedVolumes(deps, plan);
    if ((options.dialect ?? libpodLifecycleDialect).volumePrune !== undefined) {
      const pruned = yield* pruneAppScopedVolumes(deps, plan);
      volumesRemoved = volumesRemoved || pruned;
    }
  }

  return { changed: changed || networkRemoved || volumesRemoved };
});
