import { type Context, DateTime, Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError, ServiceStartError } from "@lando/sdk/errors";
import { PostServiceStartEvent, PreServiceStartEvent } from "@lando/sdk/events";
import { type AppPlan, type AppRef, ProviderId, type ServicePlan } from "@lando/sdk/schema";
import type { ApplyResult, EventService } from "@lando/sdk/services";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "./capabilities.ts";

const PROVIDER_ID = "lando";
const providerId = ProviderId.make(PROVIDER_ID);
type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;
type BringUpError = ServiceStartError | ProviderUnavailableError | ProviderInternalError;

interface InspectResult {
  readonly exists: boolean;
  readonly running: boolean;
}

interface StartResult {
  readonly name: string;
  readonly changed: boolean;
}

export interface BringUpOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly eventService?: EventPublisher;
  readonly signal?: AbortSignal;
}

interface ContainerInspect {
  readonly State?: {
    readonly Running?: boolean;
    readonly Status?: string;
  };
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
    operation: "bringUp",
    message: "provider-lando bringUp requires a Podman API client.",
  });

const podmanFailure = (service: ServicePlan, message: string, details?: unknown) =>
  new ServiceStartError({
    providerId: PROVIDER_ID,
    operation: "bringUp",
    service: service.name,
    message,
    ...(details === undefined ? {} : { details }),
  });

const request = (
  api: PodmanApiClient,
  input: PodmanHttpRequest,
): Effect.Effect<PodmanHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  api.request === undefined ? Effect.fail(missingApi()) : api.request(input);

const parseJson = (
  response: PodmanHttpResponse,
  operation: string,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : (JSON.parse(response.body) as unknown)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: PROVIDER_ID,
        operation,
        message: "Podman API returned malformed JSON.",
        details: { status: response.status, body: response.body },
        cause,
      }),
  });

const inspectContainer = (
  api: PodmanApiClient,
  name: string,
): Effect.Effect<InspectResult, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const response = yield* request(api, {
      method: "GET",
      path: `/containers/${encodeURIComponent(name)}/json`,
    });
    if (response.status === 404) {
      return { exists: false, running: false };
    }
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "bringUp.inspect",
          message: `Podman inspect failed with HTTP ${response.status}.`,
          details: { name, body: response.body },
        }),
      );
    }
    const body = yield* parseJson(response, "bringUp.inspect");
    if (typeof body !== "object" || body === null || !("State" in body)) {
      return { exists: true, running: false };
    }
    const inspect = body as ContainerInspect;
    return { exists: true, running: inspect.State?.Running === true || inspect.State?.Status === "running" };
  });

const serviceEnv = (service: ServicePlan) =>
  Object.entries(service.environment).map(([key, value]) => `${key}=${value}`);

const mountSuffix = (readOnly: boolean) => (readOnly ? ":ro" : "");

const hostConfig = (service: ServicePlan) => {
  // Only map endpoints that have a numeric port; unix-socket endpoints have
  // port === undefined and must not produce a binding key.
  const portBindings = Object.fromEntries(
    service.endpoints
      .filter((endpoint) => endpoint.port !== undefined)
      .map((endpoint) => [
        `${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}`,
        [{ HostIp: "127.0.0.1", HostPort: String(endpoint.port) }],
      ]),
  );

  // Map passthrough bind mounts; other realization types are not yet supported.
  const appMounts =
    service.appMount === undefined || service.appMount.realization !== "passthrough"
      ? []
      : [`${service.appMount.source}:${service.appMount.target}${mountSuffix(service.appMount.readOnly)}`];
  const binds = service.mounts.flatMap((mount) => {
    if (mount.type !== "bind" || mount.realization !== "passthrough") return [];
    if (mount.source === undefined) {
      throw podmanFailure(service, "provider-lando bind mounts require a source.", { mount });
    }
    return [`${mount.source}:${mount.target}${mountSuffix(mount.readOnly)}`];
  });
  const allBinds = Array.from(new Set([...appMounts, ...binds]));

  return {
    ...(Object.keys(portBindings).length > 0 ? { PortBindings: portBindings } : {}),
    ...(allBinds.length > 0 ? { Binds: allBinds } : {}),
  };
};

const createContainerBody = (plan: AppPlan, service: ServicePlan, name: string) => {
  if (service.artifact?.kind !== "ref") {
    throw podmanFailure(service, "provider-lando bringUp requires pre-built artifact references.", {
      artifact: service.artifact,
    });
  }

  // Normalize command to array; Podman container create requires Cmd as an array of strings.
  // Treat a string command as shell form so quoted arguments and shell operators are preserved.
  const normalizeCmd = (cmd: ReadonlyArray<string> | string | undefined): Array<string> | undefined => {
    if (cmd === undefined) return undefined;
    if (typeof cmd === "string") return ["sh", "-lc", cmd];
    return [...cmd];
  };

  return {
    Image: service.artifact.ref,
    name,
    Env: serviceEnv(service),
    Cmd: normalizeCmd(service.command),
    Entrypoint:
      service.entrypoint === undefined
        ? undefined
        : Array.isArray(service.entrypoint)
          ? service.entrypoint
          : [service.entrypoint],
    WorkingDir: service.workingDirectory,
    Labels: {
      "dev.lando.app": plan.id,
      "dev.lando.service": service.name,
    },
    HostConfig: hostConfig(service),
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName(plan)]: {},
      },
    },
  };
};

const ensureNetwork = (
  api: PodmanApiClient,
  plan: AppPlan,
): Effect.Effect<void, ProviderUnavailableError | ProviderInternalError> =>
  request(api, {
    method: "POST",
    path: "/networks/create",
    body: { Name: networkName(plan), Driver: "bridge", CheckDuplicate: true },
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 201 || response.status === 200 || response.status === 409
        ? Effect.void
        : Effect.fail(
            new ProviderUnavailableError({
              providerId: PROVIDER_ID,
              operation: "bringUp.network",
              message: `Podman network create failed with HTTP ${response.status}.`,
              details: { body: response.body },
            }),
          ),
    ),
  );

const createContainer = (
  api: PodmanApiClient,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
): Effect.Effect<void, BringUpError> =>
  Effect.try({
    try: () => createContainerBody(plan, service, name),
    catch: (cause) =>
      cause instanceof ServiceStartError
        ? cause
        : podmanFailure(service, "Failed to build Podman container create payload.", cause),
  }).pipe(
    Effect.flatMap((body) =>
      request(api, { method: "POST", path: `/containers/create?name=${encodeURIComponent(name)}`, body }),
    ),
    Effect.flatMap((response) =>
      response.status === 201 || response.status === 409
        ? Effect.void
        : Effect.fail(
            podmanFailure(
              service,
              `Podman container create failed with HTTP ${response.status}.`,
              response.body,
            ),
          ),
    ),
  );

const startContainer = (
  api: PodmanApiClient,
  service: ServicePlan,
  name: string,
): Effect.Effect<void, BringUpError> =>
  request(api, { method: "POST", path: `/containers/${encodeURIComponent(name)}/start` }).pipe(
    Effect.flatMap((response) =>
      response.status === 204 || response.status === 304
        ? Effect.void
        : Effect.fail(
            podmanFailure(
              service,
              `Podman container start failed with HTTP ${response.status}.`,
              response.body,
            ),
          ),
    ),
  );

const stopContainer = (api: PodmanApiClient, name: string): Effect.Effect<void> =>
  request(api, { method: "POST", path: `/containers/${encodeURIComponent(name)}/stop` }).pipe(
    Effect.catchAll(() => Effect.void),
  );

const publish = (
  eventService: BringUpOptions["eventService"],
  event: Parameters<EventPublisher["publish"]>[0],
): Effect.Effect<void, ProviderInternalError> =>
  eventService === undefined
    ? Effect.void
    : eventService.publish(event).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderInternalError({
              providerId: PROVIDER_ID,
              operation: "bringUp.event",
              message: `Failed to publish lifecycle event: ${event._tag}`,
              cause,
            }),
        ),
      );

const startService = (
  api: PodmanApiClient,
  plan: AppPlan,
  service: ServicePlan,
  options: BringUpOptions,
): Effect.Effect<StartResult, BringUpError> => {
  const name = containerName(plan, service);
  return Effect.gen(function* () {
    if (options.signal?.aborted === true) {
      yield* Effect.fail(podmanFailure(service, "Podman bringUp was cancelled before service start."));
    }

    yield* publish(
      options.eventService,
      PreServiceStartEvent.make({
        eventName: "pre-service-start",
        appRef: appRef(plan),
        serviceName: service.name,
        providerId,
        timestamp: now(),
      }),
    );

    const before = yield* inspectContainer(api, name);
    let changed = false;
    if (!before.exists) {
      yield* createContainer(api, plan, service, name);
      changed = true;
    }
    if (!before.running) {
      yield* startContainer(api, service, name);
      changed = true;
    }

    const after = yield* inspectContainer(api, name);
    if (!after.running) {
      yield* Effect.fail(podmanFailure(service, "Podman container did not reach running state."));
    }

    yield* publish(
      options.eventService,
      PostServiceStartEvent.make({
        eventName: "post-service-start",
        appRef: appRef(plan),
        serviceName: service.name,
        providerId,
        timestamp: now(),
      }),
    );

    return { name, changed };
  });
};

const cleanupStarted = (api: PodmanApiClient, names: ReadonlyArray<string>) =>
  Effect.forEach(names, (name) => stopContainer(api, name), { discard: true });

export const bringUp = (
  plan: AppPlan,
  options: BringUpOptions = {},
): Effect.Effect<ApplyResult, BringUpError> =>
  Effect.gen(function* () {
    const api = options.podmanApi;
    if (api === undefined) {
      return yield* Effect.fail(missingApi());
    }
    if (api.request === undefined) {
      return yield* Effect.fail(missingApi());
    }
    const resolvedApi: PodmanApiClient = api;

    yield* ensureNetwork(resolvedApi, plan);
    const started: string[] = [];
    let changed = false;
    for (const service of Object.values(plan.services)) {
      if (options.signal?.aborted === true) {
        yield* cleanupStarted(resolvedApi, started);
        yield* Effect.fail(podmanFailure(service, "Podman bringUp was cancelled."));
      }
      const thisName = containerName(plan, service);
      const result = yield* startService(resolvedApi, plan, service, options).pipe(
        // Include the current container in cleanup: the container may have been
        // created and started before the failure (e.g., during event publish),
        // and result.name is not yet in `started` at the tapError call site.
        Effect.tapError(() => cleanupStarted(resolvedApi, [...started, thisName])),
      );
      started.push(result.name);
      changed = changed || result.changed;
    }

    return { changed };
  });
