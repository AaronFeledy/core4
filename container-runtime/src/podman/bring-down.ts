import { type Context, Effect } from "effect";

import { type ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, type ServiceShutdownObservation, landoOwnedNetworkNames } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

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
import { inspectOwnedNativeId, isSharedNetwork, networkOwnershipLabels } from "../native-ownership.ts";
import { redactDetails, redactorFor, withApiReason } from "../redact.ts";
import { retainShutdownObservations } from "../stop-container.ts";
import { teardownVolumeClasses, volumeClassForStore } from "../volume-classes.ts";
import { planVolumeFilters } from "../volume-ownership.ts";
import { stopService } from "./stop-service.ts";
import { pruneVolumes, volumeMatchesFilters } from "./volume-prune.ts";

type EventPublisher = Pick<Context.Service.Shape<typeof EventService>, "publish">;
type BringDownError = ProviderUnavailableError | ProviderInternalError;

const DESTROY_REMEDIATION =
  "Run `lando doctor` to inspect the runtime, then `lando destroy` to retry cleanup. Use `--volumes` to remove app-scoped volumes.";

const GLOBAL_DESTROY_REMEDIATION =
  "Run `lando global:status` to inspect global services, then retry `lando global:stop`. If cleanup is still needed, run `lando global:destroy`; `--purge` also removes global service data volumes.";

interface StopResult {
  readonly changed: boolean;
  readonly shutdownObservations: readonly ServiceShutdownObservation[];
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
  const shutdownObservations: ServiceShutdownObservation[] = [];
  for (const service of Object.values(plan.services).reverse()) {
    const result = yield* stopService(plan, service, {
      ...options,
      api,
      ctx: { ...options.ctx, remediation: deps.remediation },
    }).pipe(Effect.mapError((error) => retainShutdownObservations(error, shutdownObservations)));
    changed = changed || result.changed;
    shutdownObservations.push(...result.shutdownObservations);
  }
  let networkRemoved = false;
  for (const name of landoOwnedNetworkNames(plan)) {
    const authored = plan.networking?.authoredNetworks?.find((network) => network.name === name);
    if (authored !== undefined && Object.keys(authored.members).some((member) => !(member in plan.services)))
      continue;
    const removed = yield* removeNetwork(deps, plan, name).pipe(
      Effect.mapError((error) => retainShutdownObservations(error, shutdownObservations)),
    );
    networkRemoved = networkRemoved || removed;
  }
  let volumesRemoved = false;
  if (options.volumes === true || options.purgeCaches === true) {
    volumesRemoved = yield* removeAppScopedVolumes(deps, plan).pipe(
      Effect.mapError((error) => retainShutdownObservations(error, shutdownObservations)),
    );
    if ((options.dialect ?? libpodLifecycleDialect).volumePrune !== undefined) {
      const pruned = yield* pruneAppScopedVolumes(deps, plan).pipe(
        Effect.mapError((error) => retainShutdownObservations(error, shutdownObservations)),
      );
      volumesRemoved = volumesRemoved || pruned;
    }
  }

  return { changed: changed || networkRemoved || volumesRemoved, shutdownObservations };
});
