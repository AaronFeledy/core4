import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
} from "@lando/container-runtime/plan";
import { runServiceStartSchedule } from "@lando/container-runtime/service-start-schedule";
import { type Context, DateTime, Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError, ServiceStartError } from "@lando/sdk/errors";
import { PostServiceStartEvent, PreServiceStartEvent } from "@lando/sdk/events";
import {
  type AppPlan,
  type AppRef,
  ProviderId,
  ServiceName,
  type ServicePlan,
  landoAppNetworkName,
  landoNetworkNames,
  landoServiceNetworkAliases,
  landoSharedNetworkName,
} from "@lando/sdk/schema";
import type { ApplyResult, EventService } from "@lando/sdk/services";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "./capabilities.ts";
import { realizePodmanComposeKnobs } from "./compose-knobs.ts";
import { exec } from "./exec.ts";
import { waitForExit } from "./inspect.ts";
import {
  LEFTOVER_PROXY_PORT_REMEDIATION,
  type LeftoverProxyPortPair,
  isLeftoverProxyPortBindMessage,
  leftoverProxyPortRemediation,
  readPersistedTraefikPublishPair,
} from "./leftover-proxy-port.ts";
import { redactDetails, withApiReason } from "./redact.ts";
import { volumeSelectorValue } from "./volume-prune.ts";

const appNetworkName = landoAppNetworkName;
const networkNames = landoNetworkNames;
const serviceNetworkAliases = landoServiceNetworkAliases;
const sharedNetworkName = landoSharedNetworkName;

const PROVIDER_ID = "lando";
const providerId = ProviderId.make(PROVIDER_ID);

export const scratchLabelsForPlan = (plan: AppPlan): Record<string, string> => {
  const scratch = plan.extensions["@lando/core/scratch"] as { readonly id?: string } | undefined;
  return scratch?.id === plan.id ? { "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": scratch.id } : {};
};

type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;
type BringUpError = ServiceStartError | ProviderUnavailableError | ProviderInternalError;

const APPLY_REMEDIATION =
  "Run `lando destroy` to clean up any partial app state, then retry `lando start`. Run `lando doctor` if the failure persists.";
const SETUP_REMEDIATION =
  "Run `lando setup` to install or repair the Lando runtime, then retry `lando start`.";
const NFT_REMEDIATION =
  "Netavark could not find nft. Run `lando setup` so Lando can provision nft into the managed runtime, then retry `lando start`. Do not install nft by hand and do not set network_backend=pasta.";

export const isManagedNftMissingMessage = (message: string): boolean =>
  /unable to execute ["']nft["']/iu.test(message) || /nftables error:.*\bnft\b/iu.test(message);

const detailBody = (details: unknown): string => {
  if (typeof details !== "object" || details === null || !("body" in details)) return "";
  const body = (details as { readonly body?: unknown }).body;
  return typeof body === "string" ? body : "";
};

export const startFailureRemediation = (
  message: string,
  details?: unknown,
  ports?: LeftoverProxyPortPair,
  serviceName?: string,
): string => {
  const haystack = `${message}\n${detailBody(details)}`;
  if (isManagedNftMissingMessage(haystack)) return NFT_REMEDIATION;
  const leftoverForService = serviceName === undefined || serviceName === "traefik";
  if (leftoverForService && isLeftoverProxyPortBindMessage(haystack, ports)) {
    return ports === undefined ? LEFTOVER_PROXY_PORT_REMEDIATION : leftoverProxyPortRemediation(ports);
  }
  return APPLY_REMEDIATION;
};

interface InspectResult {
  readonly exists: boolean;
  readonly running: boolean;
}

interface StartResult {
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
    providerId: service.provider,
    operation,
    service: service.name,
    message: withApiReason(message, details),
    remediation: startFailureRemediation(
      withApiReason(message, details),
      details,
      readPersistedTraefikPublishPair(),
      String(service.name),
    ),
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
          message: withApiReason(`Podman inspect failed with HTTP ${response.status}.`, {
            status: response.status,
            body: response.body,
          }),
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

const hostConfig = (plan: AppPlan, service: ServicePlan) => {
  return containerHostConfigFragment(plan, service, {
    onMissingBindMountSource: (mount) => {
      throw podmanFailure(service, "bringUp.mount", "provider-lando bind mounts require a source.", {
        mount,
      });
    },
  });
};

const createContainerRequest = (plan: AppPlan, service: ServicePlan, name: string) => {
  const knobs = realizePodmanComposeKnobs(service, {
    onInvalid: (message, details) => {
      throw podmanFailure(service, "bringUp.knobs", message, details);
    },
  });
  const baseHostConfig = hostConfig(plan, service);
  const mountTargets = new Set<string>();
  const binds = baseHostConfig.Binds;
  if (Array.isArray(binds)) {
    for (const bind of binds) {
      if (typeof bind !== "string") continue;
      const withoutOptions = bind.endsWith(":ro") ? bind.slice(0, -3) : bind;
      const separator = withoutOptions.lastIndexOf(":");
      if (separator >= 0) mountTargets.add(withoutOptions.slice(separator + 1));
    }
  }
  const mounts = baseHostConfig.Mounts;
  if (Array.isArray(mounts)) {
    for (const mount of mounts) {
      if (typeof mount !== "object" || mount === null) continue;
      const target = Reflect.get(mount, "Target");
      if (typeof target === "string") mountTargets.add(target);
    }
  }
  const tmpfs = knobs.hostConfig.Tmpfs;
  if (typeof tmpfs === "object" && tmpfs !== null && !Array.isArray(tmpfs)) {
    const collision = Object.keys(tmpfs).find((target) => mountTargets.has(target));
    if (collision !== undefined) {
      throw podmanFailure(
        service,
        "bringUp.knobs",
        "Compose tmpfs destination conflicts with a planned container mount.",
        { knob: "tmpfs", target: collision },
      );
    }
  }
  const baseExtraHosts = baseHostConfig.ExtraHosts;
  const knobExtraHosts = knobs.hostConfig.ExtraHosts;
  const mergedExtraHosts =
    Array.isArray(baseExtraHosts) && Array.isArray(knobExtraHosts)
      ? { ExtraHosts: [...baseExtraHosts, ...knobExtraHosts] }
      : {};
  const body = {
    ...containerCreateBodyFragment(plan, service, {
      name,
      labels: commonContainerLabels(plan, service, scratchLabelsForPlan(plan)),
      hostConfig: {
        ...baseHostConfig,
        ...knobs.hostConfig,
        ...mergedExtraHosts,
      },
      networkingConfig: {
        EndpointsConfig: Object.fromEntries(
          networkNames(plan).map((name) => [
            name,
            name === sharedNetworkName(plan)
              ? { Aliases: serviceNetworkAliases(plan, service) }
              : { Aliases: [service.name] },
          ]),
        ),
      },
      onMissingArtifact: (artifact) => {
        throw podmanFailure(
          service,
          "bringUp.artifact",
          "provider-lando bringUp requires pre-built artifact references.",
          { artifact },
        );
      },
    }),
    ...knobs.topLevel,
  };
  const searchParams = new URLSearchParams({ name, ...knobs.query });
  const path: PodmanHttpRequest["path"] = `/containers/create?${searchParams.toString()}`;
  return { body, path };
};

const ensureNetwork = (
  api: PodmanApiClient,
  name: string,
): Effect.Effect<boolean, ProviderUnavailableError | ProviderInternalError> => {
  return request(api, { method: "GET", path: `/networks/${encodeURIComponent(name)}` }).pipe(
    Effect.flatMap((inspectResponse) => {
      if (inspectResponse.status === 200) {
        return Effect.succeed(false);
      }
      return request(api, {
        method: "POST",
        path: "/networks/create",
        body: { Name: name, Driver: "bridge" },
      }).pipe(
        Effect.flatMap((response) => {
          if (response.status === 201 || response.status === 200) {
            return Effect.succeed(true);
          }
          if (response.status === 409) {
            return Effect.succeed(false);
          }
          const details = { status: response.status, body: response.body };
          const message = withApiReason(
            `Podman network create failed with HTTP ${response.status}.`,
            details,
          );
          return Effect.fail(
            new ProviderUnavailableError({
              providerId: PROVIDER_ID,
              operation: "bringUp.network",
              message,
              details: redactDetails(details),
              remediation: startFailureRemediation(message, details, readPersistedTraefikPublishPair()),
            }),
          );
        }),
      );
    }),
  );
};

const volumeLabels = (plan: AppPlan, store: AppPlan["stores"][number]): Readonly<Record<string, string>> => ({
  "dev.lando.app": plan.id,
  "dev.lando.provider": plan.provider,
  "dev.lando.store": store.name,
  "dev.lando.scope": store.scope,
  "dev.lando.volume-selector": volumeSelectorValue({
    providerId: plan.provider,
    appId: plan.id,
    volumeClass: store.kind === "cache" ? "cache" : "data",
  }),
  ...(store.kind === "cache" ? { "dev.lando.storage-kind": "cache" } : {}),
});

const ensureVolume = (
  api: PodmanApiClient,
  plan: AppPlan,
  store: AppPlan["stores"][number],
): Effect.Effect<boolean, ProviderUnavailableError | ProviderInternalError> =>
  request(api, {
    method: "POST",
    path: "/volumes/create",
    body: {
      Name: store.name,
      Labels: volumeLabels(plan, store),
    },
  }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 201 || response.status === 200) return Effect.succeed(true);
      if (response.status === 409) return Effect.succeed(false);
      return Effect.fail(
        new ProviderUnavailableError({
          providerId: PROVIDER_ID,
          operation: "bringUp.volume",
          message: withApiReason(`Podman volume create failed with HTTP ${response.status}.`, {
            status: response.status,
            body: response.body,
          }),
          details: redactDetails({ name: store.name, status: response.status, body: response.body }),
          remediation: APPLY_REMEDIATION,
        }),
      );
    }),
  );

const createContainer = (
  api: PodmanApiClient,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
): Effect.Effect<void, BringUpError> =>
  Effect.try({
    try: () => createContainerRequest(plan, service, name),
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
    Effect.flatMap(({ body, path }) => request(api, { method: "POST", path, body })),
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
  recordTouched: (container: TouchedContainer) => void,
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
    recordTouched({
      name,
      created: !before.exists,
      startedExisting: before.exists && !before.running,
    });
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

    return { changed };
  });
};

interface TouchedContainer {
  readonly name: string;
  readonly created: boolean;
  readonly startedExisting: boolean;
}

const cleanupTouchedContainers = (
  api: PodmanApiClient,
  touched: ReadonlyArray<TouchedContainer>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      touched.filter((container) => container.created || container.startedExisting),
      (container) => stopContainerSilent(api, container.name),
      { discard: true },
    );
    yield* Effect.forEach(
      touched.filter((container) => container.created),
      (container) => removeContainerSilent(api, container.name),
      { discard: true },
    );
  });

const rollbackPartialApply = (
  api: PodmanApiClient,
  plan: AppPlan,
  touched: ReadonlyArray<TouchedContainer>,
  createdNetworks: ReadonlySet<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Volumes are preserved so rollback does not discard persistent data.
    yield* cleanupTouchedContainers(api, touched);
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
    let changed = false;
    for (const store of plan.stores) {
      changed = (yield* ensureVolume(resolvedApi, plan, store)) || changed;
    }
    const touched: TouchedContainer[] = [];
    const result = yield* runServiceStartSchedule(plan, {
      startService: (service) =>
        Effect.gen(function* () {
          if (options.signal?.aborted === true) {
            return yield* Effect.interrupt;
          }
          const started = yield* startService(resolvedApi, plan, service, options, (container) => {
            touched.push(container);
          }).pipe(
            Effect.catchAll((error) =>
              options.signal?.aborted === true ? Effect.interrupt : Effect.fail(error),
            ),
          );
          return { changed: started.changed };
        }),
      cleanupOptionalStartFailure: (service) =>
        Effect.gen(function* () {
          const name = containerName(plan, service);
          const index = touched.findIndex((container) => container.name === name);
          const container = touched[index];
          if (container === undefined) return;
          yield* cleanupTouchedContainers(resolvedApi, [container]);
          touched.splice(index, 1);
        }),
      execHealthcheck: (service, command) =>
        exec(
          plan,
          { app: plan.id, service: service.name },
          { command, ...(options.signal === undefined ? {} : { signal: options.signal }) },
          { podmanApi: resolvedApi },
        ).pipe(Effect.map(({ exitCode }) => ({ exitCode }))),
      waitForExit: (service) =>
        waitForExit(
          plan,
          { app: plan.id, service: service.name },
          {
            podmanApi: resolvedApi,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        ).pipe(Effect.map(({ exitCode }) => ({ exitCode }))),
    }).pipe(
      Effect.tapError(() => rollbackPartialApply(resolvedApi, plan, touched, createdNetworks)),
      Effect.onInterrupt(() => rollbackPartialApply(resolvedApi, plan, touched, createdNetworks)),
    );

    if (result._tag === "Cycle") {
      yield* rollbackPartialApply(resolvedApi, plan, touched, createdNetworks);
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: PROVIDER_ID,
          operation: "bringUp.schedule",
          message: "Podman bringUp service schedule contains a dependency cycle.",
          remediation: APPLY_REMEDIATION,
          details: redactDetails({ edges: result.edges }),
        }),
      );
    }
    const [blocked] = result.blocked;
    if (blocked !== undefined) {
      yield* rollbackPartialApply(resolvedApi, plan, touched, createdNetworks);
      const service = plan.services[ServiceName.make(blocked.service)];
      if (service === undefined) {
        return yield* Effect.fail(
          new ProviderInternalError({
            providerId: PROVIDER_ID,
            operation: "bringUp.schedule",
            message: "Podman bringUp schedule blocked an unknown service.",
            remediation: APPLY_REMEDIATION,
            details: redactDetails(blocked),
          }),
        );
      }
      return yield* Effect.fail(
        podmanFailure(
          service,
          "bringUp.schedule",
          `Service ${blocked.service} could not start because dependency gate ${blocked.unmetGate} was not satisfied.`,
        ),
      );
    }

    return { changed: result.changed || changed };
  });
