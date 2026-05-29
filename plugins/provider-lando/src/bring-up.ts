import { type Context, DateTime, Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError, ServiceStartError } from "@lando/sdk/errors";
import { PostServiceStartEvent, PreServiceStartEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type AppRef,
  LANDO_SHARED_CROSS_APP_NETWORK,
  ProviderId,
  type ServicePlan,
  fileSyncVolumeName,
  landoAppNetworkName,
  landoNetworkNames,
  landoServiceNetworkAliases,
  sameAppMountTarget,
} from "@lando/sdk/schema";
import type { ApplyResult, EventService } from "@lando/sdk/services";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "./capabilities.ts";
import { redactDetails } from "./redact.ts";

const SHARED_CROSS_APP_NETWORK = LANDO_SHARED_CROSS_APP_NETWORK;
const appNetworkName = landoAppNetworkName;
const networkNames = landoNetworkNames;
const serviceNetworkAliases = landoServiceNetworkAliases;

const PROVIDER_ID = "lando";
const providerId = ProviderId.make(PROVIDER_ID);
type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;
type BringUpError = ServiceStartError | ProviderUnavailableError | ProviderInternalError;

const APPLY_REMEDIATION =
  "Run `lando destroy` to clean up any partial app state, then retry `lando start`. Run `lando doctor` if the failure persists.";
const SETUP_REMEDIATION =
  "Run `lando setup` to install or repair the Lando runtime, then retry `lando start`.";

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

const now = () => DateTime.unsafeMake(new Date().toISOString());

const missingApi = () =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "bringUp",
    message: "provider-lando bringUp requires a Podman API client.",
    remediation: SETUP_REMEDIATION,
  });

const podmanFailure = (
  service: ServicePlan,
  operation: string,
  message: string,
  details?: unknown,
  cause?: unknown,
) =>
  new ServiceStartError({
    providerId: PROVIDER_ID,
    operation,
    service: service.name,
    message,
    remediation: APPLY_REMEDIATION,
    ...(details === undefined ? {} : { details: redactDetails(details) }),
    ...(cause === undefined ? {} : { cause }),
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
        details: redactDetails({ status: response.status, body: response.body }),
        remediation: APPLY_REMEDIATION,
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
          details: redactDetails({ name, status: response.status, body: response.body }),
          remediation: APPLY_REMEDIATION,
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

const hostConfig = (plan: AppPlan, service: ServicePlan) => {
  const portBindings = Object.fromEntries(
    service.endpoints
      .filter((endpoint) => endpoint.port !== undefined)
      .map((endpoint) => [
        `${endpoint.port}/${endpoint.protocol === "udp" ? "udp" : "tcp"}`,
        [{ HostIp: "127.0.0.1", HostPort: String(endpoint.port) }],
      ]),
  );

  const appMounts =
    service.appMount === undefined
      ? []
      : [
          `${
            service.appMount.realization === "accelerated"
              ? fileSyncVolumeName(plan.name, String(service.name), "app-mount")
              : service.appMount.source
          }:${service.appMount.target}${mountSuffix(service.appMount.readOnly)}`,
        ];
  const binds = service.mounts.flatMap((mount, index) => {
    if (mount.type !== "bind") return [];
    if (sameAppMountTarget(service.appMount, mount)) return [];
    if (mount.source === undefined) {
      throw podmanFailure(service, "bringUp.mount", "provider-lando bind mounts require a source.", {
        mount,
      });
    }
    const source =
      mount.realization === "accelerated"
        ? fileSyncVolumeName(plan.name, String(service.name), `mount-${index}`)
        : mount.source;
    return [`${source}:${mount.target}${mountSuffix(mount.readOnly)}`];
  });
  const allBinds = Array.from(new Set([...appMounts, ...binds]));

  return {
    ...(Object.keys(portBindings).length > 0 ? { PortBindings: portBindings } : {}),
    ...(allBinds.length > 0 ? { Binds: allBinds } : {}),
  };
};

const createContainerBody = (plan: AppPlan, service: ServicePlan, name: string) => {
  if (service.artifact?.kind !== "ref") {
    throw podmanFailure(
      service,
      "bringUp.artifact",
      "provider-lando bringUp requires pre-built artifact references.",
      { artifact: service.artifact },
    );
  }

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
    HostConfig: hostConfig(plan, service),
    NetworkingConfig: {
      EndpointsConfig: Object.fromEntries(
        networkNames(plan).map((name) => [
          name,
          name === SHARED_CROSS_APP_NETWORK ? { Aliases: serviceNetworkAliases(plan, service) } : {},
        ]),
      ),
    },
  };
};

const ensureNetwork = (
  api: PodmanApiClient,
  name: string,
): Effect.Effect<boolean, ProviderUnavailableError | ProviderInternalError> => {
  // Inspect first — skip create if the network already exists (idempotent bringUp).
  return request(api, { method: "GET", path: `/networks/${encodeURIComponent(name)}` }).pipe(
    Effect.flatMap((inspectResponse) => {
      if (inspectResponse.status === 200) {
        // Network already exists; nothing to do.
        return Effect.succeed(false);
      }
      // Not found (404) or unexpected — attempt create.
      return request(api, {
        method: "POST",
        path: "/networks/create",
        body: { Name: name, Driver: "bridge" },
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 201 || response.status === 200
            ? Effect.succeed(true)
            : response.status === 409
              ? Effect.succeed(false)
              : Effect.fail(
                  new ProviderUnavailableError({
                    providerId: PROVIDER_ID,
                    operation: "bringUp.network",
                    message: `Podman network create failed with HTTP ${response.status}.`,
                    details: redactDetails({ status: response.status, body: response.body }),
                    remediation: APPLY_REMEDIATION,
                  }),
                ),
        ),
      );
    }),
  );
};

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
        : podmanFailure(
            service,
            "bringUp.create",
            "Failed to build Podman container create payload.",
            undefined,
            cause,
          ),
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
              "bringUp.create",
              `Podman container create failed with HTTP ${response.status}.`,
              { status: response.status, body: response.body },
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
              "bringUp.start",
              `Podman container start failed with HTTP ${response.status}.`,
              { status: response.status, body: response.body },
            ),
          ),
    ),
  );

const stopContainerSilent = (api: PodmanApiClient, name: string): Effect.Effect<void> =>
  request(api, { method: "POST", path: `/containers/${encodeURIComponent(name)}/stop` }).pipe(
    Effect.catchAll(() => Effect.void),
  );

const removeContainerSilent = (api: PodmanApiClient, name: string): Effect.Effect<void> =>
  request(api, { method: "DELETE", path: `/containers/${encodeURIComponent(name)}?force=true` }).pipe(
    Effect.catchAll(() => Effect.void),
  );

const removeNetworkSilent = (api: PodmanApiClient, plan: AppPlan): Effect.Effect<void> =>
  request(api, {
    method: "DELETE",
    path: `/networks/${encodeURIComponent(appNetworkName(plan))}`,
  }).pipe(Effect.catchAll(() => Effect.void));

const removeCreatedNetworksSilent = (
  api: PodmanApiClient,
  createdNetworks: ReadonlySet<string>,
): Effect.Effect<void> =>
  Effect.forEach(
    createdNetworks,
    (name) =>
      request(api, {
        method: "DELETE",
        path: `/networks/${encodeURIComponent(name)}`,
      }).pipe(Effect.catchAll(() => Effect.void)),
    { discard: true },
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
              remediation: APPLY_REMEDIATION,
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
      yield* Effect.fail(
        podmanFailure(service, "bringUp", "Podman bringUp was cancelled before service start."),
      );
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
      yield* Effect.fail(
        podmanFailure(service, "bringUp.start", "Podman container did not reach running state."),
      );
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

const rollbackPartialApply = (
  api: PodmanApiClient,
  plan: AppPlan,
  touched: ReadonlyArray<string>,
  createdNetworks: ReadonlySet<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // stop+force-remove every container we touched, then remove the app network.
    // stop/DELETE are idempotent on 404 so this is safe for never-created
    // containers. Volumes are preserved so rollback does not discard persistent data.
    yield* Effect.forEach(touched, (name) => stopContainerSilent(api, name), { discard: true });
    yield* Effect.forEach(touched, (name) => removeContainerSilent(api, name), { discard: true });
    yield* removeNetworkSilent(api, plan);
    yield* removeCreatedNetworksSilent(api, createdNetworks);
  });

export const bringUp = (
  plan: AppPlan,
  options: BringUpOptions = {},
): Effect.Effect<ApplyResult, BringUpError> =>
  Effect.gen(function* () {
    const api = options.podmanApi;
    if (api?.request === undefined) {
      return yield* Effect.fail(missingApi());
    }
    const resolvedApi: PodmanApiClient = api;

    const createdNetworks = new Set<string>();
    for (const name of networkNames(plan)) {
      if (yield* ensureNetwork(resolvedApi, name)) {
        createdNetworks.add(name);
      }
    }
    const touched: string[] = [];
    let changed = false;
    for (const service of Object.values(plan.services)) {
      if (options.signal?.aborted === true) {
        yield* rollbackPartialApply(resolvedApi, plan, touched, createdNetworks);
        yield* Effect.fail(podmanFailure(service, "bringUp", "Podman bringUp was cancelled."));
      }
      const thisName = containerName(plan, service);
      touched.push(thisName);
      const result = yield* startService(resolvedApi, plan, service, options).pipe(
        Effect.tapError(() => rollbackPartialApply(resolvedApi, plan, touched, createdNetworks)),
      );
      changed = changed || result.changed;
    }

    return { changed };
  });
