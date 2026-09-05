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

import { libpodWaitDialect } from "../dialect.ts";
import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
  fingerprintInspectPublishPorts,
  fingerprintPlannedPublishPorts,
} from "../plan.ts";
import { redactDetails, withApiReason } from "../redact.ts";
import { runServiceStartSchedule } from "../service-start-schedule.ts";
import { waitForExit } from "../wait-for-exit.ts";
import { realizePodmanComposeKnobs } from "./compose-knobs.ts";
import { exec } from "./exec.ts";
import { volumeSelectorValue } from "./volume-prune.ts";

const appNetworkName = landoAppNetworkName;
const networkNames = landoNetworkNames;
const serviceNetworkAliases = landoServiceNetworkAliases;
const sharedNetworkName = landoSharedNetworkName;

export const scratchLabelsForPlan = (plan: AppPlan): Record<string, string> => {
  const scratch = plan.extensions["@lando/core/scratch"];
  const scratchId = typeof scratch === "object" && scratch !== null ? Reflect.get(scratch, "id") : undefined;
  return scratchId === plan.id && typeof scratchId === "string"
    ? { "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": scratchId }
    : {};
};

type EventPublisher = Pick<Context.Tag.Service<typeof EventService>, "publish">;
type BringUpError = ServiceStartError | ProviderUnavailableError | ProviderInternalError;

/**
 * Neutral fallback used whenever a host has not installed a provider-specific
 * {@link BringUpOptions.startFailureRemediation} hook, or the hook declines a
 * failure by returning `undefined`.
 */
export const APPLY_REMEDIATION =
  "Run `lando destroy` to clean up any partial app state, then retry `lando start`. Run `lando doctor` if the failure persists.";

interface InspectResult {
  readonly exists: boolean;
  readonly running: boolean;
  readonly publishFingerprint: string;
}

interface StartResult {
  readonly changed: boolean;
}

/**
 * Provider-supplied remediation for a bring-up failure; `undefined` keeps the
 * neutral default. `service` is absent for app-scoped steps such as network
 * creation, whose failures still deserve provider-specific diagnosis.
 */
export type StartFailureRemediation = (input: {
  readonly service?: string;
  readonly message: string;
  readonly details?: unknown;
}) => string | undefined;

export interface BringUpOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly eventService?: EventPublisher;
  readonly signal?: AbortSignal;
  readonly startFailureRemediation?: StartFailureRemediation;
}

interface BringUpDeps {
  readonly api: EngineHttpApi;
  readonly options: BringUpOptions;
}

interface StartFailureInput {
  readonly service: ServicePlan;
  readonly operation: string;
  readonly message: string;
  readonly details?: unknown;
  readonly cause?: unknown;
}

const appRef = (plan: AppPlan): AppRef => ({
  kind: "user",
  id: plan.id,
  root: plan.root,
});

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const now = () => DateTime.unsafeMake(new Date().toISOString());

const containerRunning = (body: object): boolean => {
  const state = Reflect.get(body, "State");
  if (typeof state !== "object" || state === null) return false;
  return Reflect.get(state, "Running") === true || Reflect.get(state, "Status") === "running";
};

const missingApi = (ctx: ProviderErrorContext) =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "bringUp",
    message: `provider-${ctx.providerId} bringUp requires a Podman API client.`,
    remediation: ctx.remediation,
  });

const podmanFailure = (deps: BringUpDeps, input: StartFailureInput) => {
  const message = withApiReason(input.message, input.details);
  const remediation =
    deps.options.startFailureRemediation?.({
      service: String(input.service.name),
      message,
      ...(input.details === undefined ? {} : { details: input.details }),
    }) ?? APPLY_REMEDIATION;
  return new ServiceStartError({
    providerId: input.service.provider,
    operation: input.operation,
    service: input.service.name,
    message,
    remediation,
    ...(input.details === undefined ? {} : { details: redactDetails(input.details) }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
};

const request = (
  deps: BringUpDeps,
  input: EngineHttpRequest,
): Effect.Effect<EngineHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  deps.api.request === undefined ? Effect.fail(missingApi(deps.options.ctx)) : deps.api.request(input);

const parseJson = (
  deps: BringUpDeps,
  response: EngineHttpResponse,
  operation: string,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : (JSON.parse(response.body) as unknown)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: deps.options.ctx.providerId,
        operation,
        message: "Podman API returned malformed JSON.",
        details: redactDetails({ status: response.status, body: response.body }),
        remediation: APPLY_REMEDIATION,
        cause,
      }),
  });

const inspectContainer = (
  deps: BringUpDeps,
  name: string,
): Effect.Effect<InspectResult, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const response = yield* request(deps, {
      method: "GET",
      path: `/containers/${encodeURIComponent(name)}/json`,
    });
    if (response.status === 404) {
      return { exists: false, running: false, publishFingerprint: "" };
    }
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: deps.options.ctx.providerId,
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
    const body = yield* parseJson(deps, response, "bringUp.inspect");
    if (typeof body !== "object" || body === null || !("State" in body)) {
      return { exists: true, running: false, publishFingerprint: fingerprintInspectPublishPorts(body) };
    }
    return {
      exists: true,
      running: containerRunning(body),
      publishFingerprint: fingerprintInspectPublishPorts(body),
    };
  });

const hostConfig = (deps: BringUpDeps, plan: AppPlan, service: ServicePlan) => {
  return containerHostConfigFragment(plan, service, {
    onMissingBindMountSource: (mount) => {
      throw podmanFailure(deps, {
        service,
        operation: "bringUp.mount",
        message: `provider-${deps.options.ctx.providerId} bind mounts require a source.`,
        details: { mount },
      });
    },
  });
};

const createContainerRequest = (deps: BringUpDeps, plan: AppPlan, service: ServicePlan, name: string) => {
  const knobs = realizePodmanComposeKnobs(service, {
    onInvalid: (message, details) => {
      throw podmanFailure(deps, { service, operation: "bringUp.knobs", message, details });
    },
  });
  const baseHostConfig = hostConfig(deps, plan, service);
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
      throw podmanFailure(deps, {
        service,
        operation: "bringUp.knobs",
        message: "Compose tmpfs destination conflicts with a planned container mount.",
        details: { knob: "tmpfs", target: collision },
      });
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
        throw podmanFailure(deps, {
          service,
          operation: "bringUp.artifact",
          message: `provider-${deps.options.ctx.providerId} bringUp requires pre-built artifact references.`,
          details: { artifact },
        });
      },
    }),
    ...knobs.topLevel,
  };
  const searchParams = new URLSearchParams({ name, ...knobs.query });
  const path: EngineHttpRequest["path"] = `/containers/create?${searchParams.toString()}`;
  return { body, path };
};

const ensureNetwork = (
  deps: BringUpDeps,
  name: string,
): Effect.Effect<boolean, ProviderUnavailableError | ProviderInternalError> => {
  return request(deps, { method: "GET", path: `/networks/${encodeURIComponent(name)}` }).pipe(
    Effect.flatMap((inspectResponse) => {
      if (inspectResponse.status === 200) {
        return Effect.succeed(false);
      }
      return request(deps, {
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
              providerId: deps.options.ctx.providerId,
              operation: "bringUp.network",
              message,
              details: redactDetails(details),
              remediation: deps.options.startFailureRemediation?.({ message, details }) ?? APPLY_REMEDIATION,
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
  deps: BringUpDeps,
  plan: AppPlan,
  store: AppPlan["stores"][number],
): Effect.Effect<boolean, ProviderUnavailableError | ProviderInternalError> =>
  request(deps, {
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
          providerId: deps.options.ctx.providerId,
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
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  name: string,
): Effect.Effect<void, BringUpError> =>
  Effect.try({
    try: () => createContainerRequest(deps, plan, service, name),
    catch: (cause) =>
      cause instanceof ServiceStartError
        ? cause
        : podmanFailure(deps, {
            service,
            operation: "bringUp.create",
            message: "Failed to build Podman container create payload.",
            cause,
          }),
  }).pipe(
    Effect.flatMap(({ body, path }) => request(deps, { method: "POST", path, body })),
    Effect.flatMap((response) =>
      response.status === 201 || response.status === 409
        ? Effect.void
        : Effect.fail(
            podmanFailure(deps, {
              service,
              operation: "bringUp.create",
              message: `Podman container create failed with HTTP ${response.status}.`,
              details: { status: response.status, body: response.body },
            }),
          ),
    ),
  );

const startContainer = (
  deps: BringUpDeps,
  service: ServicePlan,
  name: string,
): Effect.Effect<void, BringUpError> =>
  request(deps, { method: "POST", path: `/containers/${encodeURIComponent(name)}/start` }).pipe(
    Effect.flatMap((response) =>
      response.status === 204 || response.status === 304
        ? Effect.void
        : Effect.fail(
            podmanFailure(deps, {
              service,
              operation: "bringUp.start",
              message: `Podman container start failed with HTTP ${response.status}.`,
              details: { status: response.status, body: response.body },
            }),
          ),
    ),
  );

const stopContainerSilent = (deps: BringUpDeps, name: string): Effect.Effect<void> =>
  request(deps, { method: "POST", path: `/containers/${encodeURIComponent(name)}/stop` }).pipe(
    Effect.catchAll(() => Effect.void),
  );

const removeContainerSilent = (deps: BringUpDeps, name: string): Effect.Effect<void> =>
  request(deps, { method: "DELETE", path: `/containers/${encodeURIComponent(name)}?force=true` }).pipe(
    Effect.catchAll(() => Effect.void),
  );

const removeContainer = (
  deps: BringUpDeps,
  service: ServicePlan,
  name: string,
): Effect.Effect<void, BringUpError> =>
  request(deps, { method: "DELETE", path: `/containers/${encodeURIComponent(name)}?force=true` }).pipe(
    Effect.flatMap((response) =>
      response.status === 204 || response.status === 200 || response.status === 404
        ? Effect.void
        : Effect.fail(
            podmanFailure(deps, {
              service,
              operation: "bringUp.remove",
              message: `Podman container remove failed with HTTP ${response.status}.`,
              details: { status: response.status, body: response.body },
            }),
          ),
    ),
  );

const removeNetworkSilent = (deps: BringUpDeps, plan: AppPlan): Effect.Effect<void> =>
  request(deps, {
    method: "DELETE",
    path: `/networks/${encodeURIComponent(appNetworkName(plan))}`,
  }).pipe(Effect.catchAll(() => Effect.void));

const removeCreatedNetworksSilent = (
  deps: BringUpDeps,
  createdNetworks: ReadonlySet<string>,
): Effect.Effect<void> =>
  Effect.forEach(
    createdNetworks,
    (name) =>
      request(deps, {
        method: "DELETE",
        path: `/networks/${encodeURIComponent(name)}`,
      }).pipe(Effect.catchAll(() => Effect.void)),
    { discard: true },
  );

const publish = (
  deps: BringUpDeps,
  event: Parameters<EventPublisher["publish"]>[0],
): Effect.Effect<void, ProviderInternalError> =>
  deps.options.eventService === undefined
    ? Effect.void
    : deps.options.eventService.publish(event).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderInternalError({
              providerId: deps.options.ctx.providerId,
              operation: "bringUp.event",
              message: `Failed to publish lifecycle event: ${event._tag}`,
              remediation: APPLY_REMEDIATION,
              cause,
            }),
        ),
      );

const startService = (
  deps: BringUpDeps,
  plan: AppPlan,
  service: ServicePlan,
  recordTouched: (container: TouchedContainer) => void,
): Effect.Effect<StartResult, BringUpError> => {
  const name = containerName(plan, service);
  const providerId = ProviderId.make(deps.options.ctx.providerId);
  return Effect.gen(function* () {
    if (deps.options.signal?.aborted === true) {
      yield* Effect.fail(
        podmanFailure(deps, {
          service,
          operation: "bringUp",
          message: "Podman bringUp was cancelled before service start.",
        }),
      );
    }

    yield* publish(
      deps,
      PreServiceStartEvent.make({
        eventName: "pre-service-start",
        appRef: appRef(plan),
        serviceName: service.name,
        providerId,
        timestamp: now(),
      }),
    );

    const inspected = yield* inspectContainer(deps, name);
    const published = service.endpoints.flatMap((endpoint) =>
      endpoint._tag === "published" ? [endpoint] : [],
    );
    const plannedFingerprint = fingerprintPlannedPublishPorts(published);
    let before = inspected;
    if (
      before.exists &&
      plannedFingerprint.length > 0 &&
      before.publishFingerprint.length > 0 &&
      before.publishFingerprint !== plannedFingerprint
    ) {
      yield* stopContainerSilent(deps, name);
      yield* removeContainer(deps, service, name);
      before = { exists: false, running: false, publishFingerprint: "" };
    }
    recordTouched({
      name,
      created: !before.exists,
      startedExisting: before.exists && !before.running,
    });
    let changed = false;
    if (!before.exists) {
      yield* createContainer(deps, plan, service, name);
      changed = true;
    }
    if (!before.running) {
      yield* startContainer(deps, service, name);
      changed = true;
    }

    const after = yield* inspectContainer(deps, name);
    if (!after.running) {
      yield* Effect.fail(
        podmanFailure(deps, {
          service,
          operation: "bringUp.start",
          message: "Podman container did not reach running state.",
        }),
      );
    }

    yield* publish(
      deps,
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
  deps: BringUpDeps,
  touched: ReadonlyArray<TouchedContainer>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      touched.filter((container) => container.created || container.startedExisting),
      (container) => stopContainerSilent(deps, container.name),
      { discard: true },
    );
    yield* Effect.forEach(
      touched.filter((container) => container.created),
      (container) => removeContainerSilent(deps, container.name),
      { discard: true },
    );
  });

const rollbackPartialApply = (
  deps: BringUpDeps,
  plan: AppPlan,
  touched: ReadonlyArray<TouchedContainer>,
  createdNetworks: ReadonlySet<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Volumes are preserved so rollback does not discard persistent data.
    yield* cleanupTouchedContainers(deps, touched);
    yield* removeNetworkSilent(deps, plan);
    yield* removeCreatedNetworksSilent(deps, createdNetworks);
  });

export const bringUp = (plan: AppPlan, options: BringUpOptions): Effect.Effect<ApplyResult, BringUpError> =>
  Effect.gen(function* () {
    const api = options.api;
    if (api?.request === undefined) {
      return yield* Effect.fail(missingApi(options.ctx));
    }
    const deps: BringUpDeps = { api, options };

    const createdNetworks = new Set<string>();
    for (const name of networkNames(plan)) {
      if (yield* ensureNetwork(deps, name)) {
        createdNetworks.add(name);
      }
    }
    let changed = false;
    for (const store of plan.stores) {
      changed = (yield* ensureVolume(deps, plan, store)) || changed;
    }
    const touched: TouchedContainer[] = [];
    const result = yield* runServiceStartSchedule(plan, {
      startService: (service) =>
        Effect.gen(function* () {
          if (options.signal?.aborted === true) {
            return yield* Effect.interrupt;
          }
          const started = yield* startService(deps, plan, service, (container) => {
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
          yield* cleanupTouchedContainers(deps, [container]);
          touched.splice(index, 1);
        }),
      execHealthcheck: (service, command) =>
        exec(
          plan,
          { app: plan.id, service: service.name },
          { command, ...(options.signal === undefined ? {} : { signal: options.signal }) },
          { api, ctx: options.ctx },
        ).pipe(Effect.map(({ exitCode }) => ({ exitCode }))),
      waitForExit: (service) =>
        waitForExit(
          plan,
          { app: plan.id, service: service.name },
          {
            api,
            ctx: options.ctx,
            dialect: libpodWaitDialect,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        ).pipe(Effect.map(({ exitCode }) => ({ exitCode }))),
    }).pipe(
      Effect.tapError(() => rollbackPartialApply(deps, plan, touched, createdNetworks)),
      Effect.onInterrupt(() => rollbackPartialApply(deps, plan, touched, createdNetworks)),
    );

    if (result._tag === "Cycle") {
      yield* rollbackPartialApply(deps, plan, touched, createdNetworks);
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: options.ctx.providerId,
          operation: "bringUp.schedule",
          message: "Podman bringUp service schedule contains a dependency cycle.",
          remediation: APPLY_REMEDIATION,
          details: redactDetails({ edges: result.edges }),
        }),
      );
    }
    const [blocked] = result.blocked;
    if (blocked !== undefined) {
      yield* rollbackPartialApply(deps, plan, touched, createdNetworks);
      const service = plan.services[ServiceName.make(blocked.service)];
      if (service === undefined) {
        return yield* Effect.fail(
          new ProviderInternalError({
            providerId: options.ctx.providerId,
            operation: "bringUp.schedule",
            message: "Podman bringUp schedule blocked an unknown service.",
            remediation: APPLY_REMEDIATION,
            details: redactDetails(blocked),
          }),
        );
      }
      return yield* Effect.fail(
        podmanFailure(deps, {
          service,
          operation: "bringUp.schedule",
          message: `Service ${blocked.service} could not start because dependency gate ${blocked.unmetGate} was not satisfied.`,
        }),
      );
    }

    return { changed: result.changed || changed };
  });
