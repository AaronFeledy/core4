import { type Context, DateTime, Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { PostServiceStopEvent, PreServiceStopEvent } from "@lando/sdk/events";
import { type AppPlan, type AppRef, ProviderId, type ServicePlan } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { redactDetails, withApiReason } from "../redact.ts";
import {
  type VolumeSelectorClass,
  buildLandoVolumeFilters,
  pruneVolumes,
  volumeMatchesFilters,
} from "./volume-prune.ts";

type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;
type BringDownError = ProviderUnavailableError | ProviderInternalError;

const DESTROY_REMEDIATION =
  "Run `lando doctor` to inspect the runtime, then `lando destroy` to retry cleanup. Use `--volumes` to remove app-scoped volumes.";

interface StopResult {
  readonly changed: boolean;
}

export interface BringDownOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly eventService?: EventPublisher;
  readonly volumes?: boolean;
  readonly purgeCaches?: boolean;
}

interface BringDownDeps {
  readonly api: EngineHttpApi;
  readonly options: BringDownOptions;
}

const appRef = (plan: AppPlan): AppRef => ({
  kind: "user",
  id: plan.id,
  root: plan.root,
});

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const networkName = (plan: AppPlan) => `lando-${plan.slug}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const now = () => DateTime.unsafeMake(new Date().toISOString());

const missingApi = (ctx: ProviderErrorContext) =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "bringDown",
    message: `provider-${ctx.providerId} bringDown requires a Podman API client.`,
    remediation: ctx.remediation,
  });

const request = (
  deps: BringDownDeps,
  input: EngineHttpRequest,
): Effect.Effect<EngineHttpResponse, BringDownError> =>
  deps.api.request === undefined ? Effect.fail(missingApi(deps.options.ctx)) : deps.api.request(input);

const podmanFailure = (ctx: ProviderErrorContext, operation: string, message: string, details?: unknown) =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation,
    message: withApiReason(message, details),
    remediation: DESTROY_REMEDIATION,
    ...(details === undefined ? {} : { details: redactDetails(details) }),
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
              remediation: DESTROY_REMEDIATION,
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
          deps.options.ctx,
          "bringDown.stop",
          `Podman container stop failed with HTTP ${response.status}.`,
          { name, body: response.body },
        ),
      );
    }),
  );

const removeContainer = (deps: BringDownDeps, name: string): Effect.Effect<boolean, BringDownError> =>
  request(deps, { method: "DELETE", path: `/containers/${encodeURIComponent(name)}?force=true` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 200 || response.status === 204) {
        return Effect.succeed(true);
      }
      if (response.status === 404) {
        return Effect.succeed(false);
      }
      return Effect.fail(
        podmanFailure(
          deps.options.ctx,
          "bringDown.remove",
          `Podman container remove failed with HTTP ${response.status}.`,
          { name, body: response.body },
        ),
      );
    }),
  );

const removeNetwork = (deps: BringDownDeps, plan: AppPlan): Effect.Effect<boolean, BringDownError> => {
  const name = networkName(plan);
  return request(deps, { method: "DELETE", path: `/networks/${encodeURIComponent(name)}` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 200 || response.status === 204) {
        return Effect.succeed(true);
      }
      if (response.status === 404) {
        return Effect.succeed(false);
      }
      return Effect.fail(
        podmanFailure(
          deps.options.ctx,
          "bringDown.network",
          `Podman network remove failed with HTTP ${response.status}.`,
          { name, body: response.body },
        ),
      );
    }),
  );
};

const parseVolumeLabels = (body: string): Readonly<Record<string, string>> | undefined => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = Reflect.get(parsed, "Labels");
    if (typeof value !== "object" || value === null) return undefined;
    const labels: Record<string, string> = {};
    for (const [key, label] of Object.entries(value)) {
      if (typeof label === "string") labels[key] = label;
    }
    return labels;
  } catch {
    return undefined;
  }
};

const removeVolume = (
  deps: BringDownDeps,
  plan: AppPlan,
  store: AppPlan["stores"][number],
): Effect.Effect<boolean, BringDownError> =>
  Effect.gen(function* () {
    const name = store.name;
    const inspected = yield* request(deps, {
      method: "GET",
      path: `/volumes/${encodeURIComponent(name)}`,
    });
    if (inspected.status === 404) return false;
    if (inspected.status !== 200) {
      return yield* Effect.fail(
        podmanFailure(
          deps.options.ctx,
          "bringDown.volume.inspect",
          `Podman volume inspect failed with HTTP ${inspected.status}.`,
          { name, body: inspected.body },
        ),
      );
    }
    const labels = parseVolumeLabels(inspected.body);
    const volumeClass: VolumeSelectorClass = store.kind === "cache" ? "cache" : "data";
    if (
      labels === undefined ||
      !volumeMatchesFilters(
        labels,
        buildLandoVolumeFilters(plan.id, { providerId: plan.provider, volumeClasses: [volumeClass] }),
      )
    ) {
      return false;
    }
    const response = yield* request(deps, {
      method: "DELETE",
      path: `/volumes/${encodeURIComponent(name)}`,
    });
    if (response.status === 200 || response.status === 204) return true;
    if (response.status === 404) return false;
    return yield* Effect.fail(
      podmanFailure(
        deps.options.ctx,
        "bringDown.volume",
        `Podman volume remove failed with HTTP ${response.status}.`,
        { name, body: response.body },
      ),
    );
  });

const removeAppScopedVolumes = (deps: BringDownDeps, plan: AppPlan): Effect.Effect<boolean, BringDownError> =>
  Effect.gen(function* () {
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

const pruneVolumeClasses = (options: BringDownOptions): ReadonlyArray<VolumeSelectorClass> => {
  if (options.volumes === true && options.purgeCaches === true) return ["cache", "data"];
  return options.purgeCaches === true ? ["cache"] : ["data"];
};

const pruneAppScopedVolumes = (deps: BringDownDeps, plan: AppPlan): Effect.Effect<boolean, BringDownError> =>
  pruneVolumes(deps.api, {
    filters: buildLandoVolumeFilters(plan.id, {
      providerId: plan.provider,
      volumeClasses: pruneVolumeClasses(deps.options),
    }),
    ctx: deps.options.ctx,
    all: deps.options.volumes === true,
  }).pipe(Effect.map((report) => report.pruned.length > 0 || report.errors.length > 0));

const stopService = (
  deps: BringDownDeps,
  plan: AppPlan,
  service: ServicePlan,
): Effect.Effect<StopResult, BringDownError> => {
  const name = containerName(plan, service);
  const providerId = ProviderId.make(deps.options.ctx.providerId);
  return Effect.gen(function* () {
    yield* publish(
      deps,
      PreServiceStopEvent.make({
        eventName: "pre-service-stop",
        appRef: appRef(plan),
        serviceName: service.name,
        providerId,
        timestamp: now(),
      }),
    );

    const stopped = yield* stopContainer(deps, name);
    const removed = yield* removeContainer(deps, name);

    yield* publish(
      deps,
      PostServiceStopEvent.make({
        eventName: "post-service-stop",
        appRef: appRef(plan),
        serviceName: service.name,
        providerId,
        timestamp: now(),
      }),
    );

    return { changed: stopped || removed };
  });
};

export const bringDown = (
  plan: AppPlan,
  options: BringDownOptions,
): Effect.Effect<StopResult, BringDownError> =>
  Effect.gen(function* () {
    const api = options.api;
    if (api === undefined) {
      return yield* Effect.fail(missingApi(options.ctx));
    }
    if (api.request === undefined) {
      return yield* Effect.fail(missingApi(options.ctx));
    }
    const deps: BringDownDeps = { api, options };

    let changed = false;
    for (const service of Object.values(plan.services).reverse()) {
      const result = yield* stopService(deps, plan, service);
      changed = changed || result.changed;
    }
    const networkRemoved = yield* removeNetwork(deps, plan);
    const volumesRemoved =
      options.volumes === true || options.purgeCaches === true
        ? yield* removeAppScopedVolumes(deps, plan).pipe(
            Effect.zipWith(pruneAppScopedVolumes(deps, plan), (removed, pruned) => removed || pruned),
          )
        : false;

    return { changed: changed || networkRemoved || volumesRemoved };
  });
