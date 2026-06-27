import { type Context, DateTime, Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { PostServiceStopEvent, PreServiceStopEvent } from "@lando/sdk/events";
import { type AppPlan, type AppRef, ProviderId, type ServicePlan } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "./capabilities.ts";
import { redactDetails, withApiReason } from "./redact.ts";

const PROVIDER_ID = "lando";
const providerId = ProviderId.make(PROVIDER_ID);
type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;
type BringDownError = ProviderUnavailableError | ProviderInternalError;

const DESTROY_REMEDIATION =
  "Run `lando doctor` to inspect the runtime, then `lando destroy` to retry cleanup. Use `--volumes` to remove app-scoped volumes.";
const SETUP_REMEDIATION =
  "Run `lando setup` to install or repair the Lando runtime, then retry `lando destroy`.";

interface StopResult {
  readonly changed: boolean;
}

export interface BringDownOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly eventService?: EventPublisher;
  readonly volumes?: boolean;
  readonly purgeCaches?: boolean;
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

const missingApi = () =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "bringDown",
    message: "provider-lando bringDown requires a Podman API client.",
    remediation: SETUP_REMEDIATION,
  });

const request = (
  api: PodmanApiClient,
  input: PodmanHttpRequest,
): Effect.Effect<PodmanHttpResponse, BringDownError> =>
  api.request === undefined ? Effect.fail(missingApi()) : api.request(input);

const podmanFailure = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message: withApiReason(message, details),
    remediation: DESTROY_REMEDIATION,
    ...(details === undefined ? {} : { details: redactDetails(details) }),
    ...(cause === undefined ? {} : { cause }),
  });

const publish = (
  eventService: BringDownOptions["eventService"],
  event: Parameters<EventPublisher["publish"]>[0],
): Effect.Effect<void, ProviderInternalError> =>
  eventService === undefined
    ? Effect.void
    : eventService.publish(event).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderInternalError({
              providerId: PROVIDER_ID,
              operation: "bringDown.event",
              message: `Failed to publish lifecycle event: ${event._tag}`,
              remediation: DESTROY_REMEDIATION,
              cause,
            }),
        ),
      );

const stopContainer = (api: PodmanApiClient, name: string): Effect.Effect<boolean, BringDownError> =>
  request(api, { method: "POST", path: `/containers/${encodeURIComponent(name)}/stop` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 204) {
        return Effect.succeed(true);
      }
      if (response.status === 304 || response.status === 404) {
        return Effect.succeed(false);
      }
      return Effect.fail(
        podmanFailure("bringDown.stop", `Podman container stop failed with HTTP ${response.status}.`, {
          name,
          body: response.body,
        }),
      );
    }),
  );

const removeContainer = (api: PodmanApiClient, name: string): Effect.Effect<boolean, BringDownError> =>
  request(api, { method: "DELETE", path: `/containers/${encodeURIComponent(name)}?force=true` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 200 || response.status === 204) {
        return Effect.succeed(true);
      }
      if (response.status === 404) {
        return Effect.succeed(false);
      }
      return Effect.fail(
        podmanFailure("bringDown.remove", `Podman container remove failed with HTTP ${response.status}.`, {
          name,
          body: response.body,
        }),
      );
    }),
  );

const removeNetwork = (api: PodmanApiClient, plan: AppPlan): Effect.Effect<boolean, BringDownError> => {
  const name = networkName(plan);
  return request(api, { method: "DELETE", path: `/networks/${encodeURIComponent(name)}` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 200 || response.status === 204) {
        return Effect.succeed(true);
      }
      if (response.status === 404) {
        return Effect.succeed(false);
      }
      return Effect.fail(
        podmanFailure("bringDown.network", `Podman network remove failed with HTTP ${response.status}.`, {
          name,
          body: response.body,
        }),
      );
    }),
  );
};

const removeVolume = (api: PodmanApiClient, name: string): Effect.Effect<boolean, BringDownError> =>
  request(api, { method: "DELETE", path: `/volumes/${encodeURIComponent(name)}` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 200 || response.status === 204) {
        return Effect.succeed(true);
      }
      if (response.status === 404) {
        return Effect.succeed(false);
      }
      return Effect.fail(
        podmanFailure("bringDown.volume", `Podman volume remove failed with HTTP ${response.status}.`, {
          name,
          body: response.body,
        }),
      );
    }),
  );

const removeAppScopedVolumes = (
  api: PodmanApiClient,
  plan: AppPlan,
  options: BringDownOptions,
): Effect.Effect<boolean, BringDownError> =>
  Effect.gen(function* () {
    let changed = false;
    for (const store of plan.stores) {
      if (store.kind === "cache") {
        if (options.purgeCaches !== true) continue;
      } else if (store.scope === "global" || options.volumes !== true) {
        continue;
      }
      const removed = yield* removeVolume(api, store.name);
      changed = changed || removed;
    }
    return changed;
  });

const stopService = (
  api: PodmanApiClient,
  plan: AppPlan,
  service: ServicePlan,
  options: BringDownOptions,
): Effect.Effect<StopResult, BringDownError> => {
  const name = containerName(plan, service);
  return Effect.gen(function* () {
    yield* publish(
      options.eventService,
      PreServiceStopEvent.make({
        eventName: "pre-service-stop",
        appRef: appRef(plan),
        serviceName: service.name,
        providerId,
        timestamp: now(),
      }),
    );

    const stopped = yield* stopContainer(api, name);
    const removed = yield* removeContainer(api, name);

    yield* publish(
      options.eventService,
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
  options: BringDownOptions = {},
): Effect.Effect<StopResult, BringDownError> =>
  Effect.gen(function* () {
    const api = options.podmanApi;
    if (api === undefined) {
      return yield* Effect.fail(missingApi());
    }
    if (api.request === undefined) {
      return yield* Effect.fail(missingApi());
    }

    let changed = false;
    for (const service of Object.values(plan.services).reverse()) {
      const result = yield* stopService(api, plan, service, options);
      changed = changed || result.changed;
    }
    const networkRemoved = yield* removeNetwork(api, plan);
    const volumesRemoved =
      options.volumes === true || options.purgeCaches === true
        ? yield* removeAppScopedVolumes(api, plan, options)
        : false;

    return { changed: changed || networkRemoved || volumesRemoved };
  });
