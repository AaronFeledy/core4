import { DateTime, Effect, Layer, Option, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import { redactString, standaloneSecretsRedactor } from "@lando/container-runtime/redact";
import { CaError, ProxyApplyError, ProxyError, ProxySetupError, RouterWatcherError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId, type ProxyConfig, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import {
  CertificateAuthority,
  EventService,
  FileSystem,
  GlobalAppService,
  InteractionService,
  PathsService,
  PrivilegeService,
  ProcessRunner,
  RouterService,
  type RouterServiceShape,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";

import { makeRouteApplication } from "./apply-routes.ts";
import { ensureDashboardFile } from "./dashboard.ts";
import { TRAEFIK_DIAGNOSTICS_ID, renderTraefikFallbackConfig } from "./diagnostics.ts";
import { makeRouteObserver } from "./observe-routes.ts";
import { fingerprintsEqual } from "./port-acquisition-helpers.ts";
import {
  persistPortAcquisition,
  readAcquisitionState,
  writeAcquisitionState,
} from "./port-acquisition-state.ts";
import {
  ROUTE_FILE_PREFIX,
  ROUTE_FILE_SUFFIX,
  acquisitionStateFile,
  dashboardConfigFile,
  defaultDomainFile,
  defaultTlsFile,
  dynamicConfigDir,
  fallbackConfigFile,
  joinFor,
  routeFile,
  routingStateFile,
  watcherDiagnosticFile,
} from "./proxy-paths.ts";
import {
  advertisedPorts,
  assertAdvertisedForward,
  mapSetupError,
  publishFallbackWarn,
} from "./proxy-setup.ts";
import type { TraefikProxyDependencies, TraefikRouterLists, TraefikRouterPin } from "./proxy-types.ts";
import { invalidateAcknowledgement, routeReloadLockKey } from "./route-reload-state.ts";
import { advertisedRouterBindAddress, normalizeRouterBindAddress } from "./router-bind-address.ts";
import { type AuthorityPorts, DEFAULT_AUTHORITY_PORTS } from "./routing.ts";
import { writeSecretAtomic } from "./secret-file.ts";
import { stopSockets } from "./socket-proxy-install.ts";
import { liveSocketProxy } from "./socket-proxy-setup.ts";
import { persistedStatus } from "./status.ts";
import { normalizeDefaultDomain, removeAllCertificates, removeAppCertificates } from "./tls.ts";
import { clearWatcherDiagnostic, writeWatcherDiagnostic } from "./watcher-diagnostic-state.ts";
import {
  boundWatcherDetail,
  classifyWatcherFailure,
  watcherHostLabel,
  watcherRemediations,
} from "./watcher-diagnostics.ts";

export { renderTraefikDynamicConfig } from "./routing.ts";

const TRAEFIK_PROXY_ID = "traefik";
const ROUTE_RELOAD_LOCK_WAIT_MS = 120_000;
const TRAEFIK_DYNAMIC_CONFIG_SOURCE = "./proxy-traefik/dynamic";

const observeWatcherStartup = Effect.fn("TraefikRouter.observeWatcherStartup")(function* (
  dependencies: TraefikProxyDependencies,
) {
  if (dependencies.readTraefikLogs === undefined) return;
  const observation = Option.getOrUndefined(yield* Effect.option(dependencies.readTraefikLogs()));
  if (observation === undefined) return;
  const hit = classifyWatcherFailure(observation.text);
  if (hit === undefined) {
    yield* clearWatcherDiagnostic(dependencies.fileSystem, dependencies.paths);
    return;
  }
  const fallbackRedactor = standaloneSecretsRedactor({ ...process.env });
  const redact = dependencies.redactDiagnostic ?? ((value: string) => redactString(value, fallbackRedactor));
  const detail = boundWatcherDetail(redact(hit.detail));
  const watcherHost = watcherHostLabel({
    providerId: observation.providerId,
    platform: dependencies.paths.platform,
  });
  const error = new RouterWatcherError({
    message: `The Traefik router encountered a ${hit.failureClass} file watcher failure on ${watcherHost}.`,
    proxyId: TRAEFIK_PROXY_ID,
    failureClass: hit.failureClass,
    watcherHost,
    detail,
    // Descriptions already end in a period, so a space keeps the ordered
    // remediation readable as prose with the non-privileged action first.
    remediation: watcherRemediations(hit.failureClass, watcherHost)
      .map(({ description }) => description)
      .join(" "),
  });
  yield* writeWatcherDiagnostic(dependencies.fileSystem, dependencies.paths, {
    version: 1,
    observedAt: DateTime.formatIso(yield* DateTime.now),
    providerId: observation.providerId,
    watcherHost,
    failureClass: hit.failureClass,
    detail,
  }).pipe(Effect.catch(() => Effect.void));
  yield* dependencies.fileSystem
    .remove(routingStateFile(dependencies.paths))
    .pipe(Effect.catch(() => Effect.void));
  return yield* Effect.fail(error);
});

const confirmRouterAcquisition = Effect.fnUntraced(function* (dependencies: TraefikProxyDependencies) {
  const state = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
  if (
    state === undefined ||
    dependencies.readTraefikPublications === undefined ||
    (state.appliedFingerprint !== undefined && fingerprintsEqual(state.fingerprint, state.appliedFingerprint))
  )
    return;
  const observed = yield* dependencies.readTraefikPublications().pipe(
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed({ status: "unknown" as const })),
  );
  if (observed.status !== "present") return;
  const bindAddress = advertisedRouterBindAddress(state);
  const expected = [
    { port: 80, hostPort: state.bindHttpPort ?? state.httpPort },
    { port: 443, hostPort: state.bindHttpsPort ?? state.httpsPort },
  ];
  if (
    !expected.every((target) => {
      const bindings = observed.bindings.filter(
        (binding) => binding.transport === "tcp" && binding.port === target.port,
      );
      return (
        bindings.length > 0 &&
        bindings.every(
          (binding) =>
            binding.hostPort === target.hostPort &&
            normalizeRouterBindAddress(binding.bindAddress) === bindAddress,
        )
      );
    })
  )
    return;
  yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
    ...state,
    appliedFingerprint: state.fingerprint,
  });
});

// observeWatcherStartup removes .lando-routing-state on failure; persistedStatus
// reports stopped without it. Every successful observation must rewrite the
// fallback config and routing marker together.
const finalizeRouterStartup = Effect.fn("TraefikRouter.finalizeRouterStartup")(function* (
  dependencies: TraefikProxyDependencies,
  advertised: AuthorityPorts,
  context: "setup" | "revalidation",
) {
  const ready = yield* assertAdvertisedForward(dependencies, advertised, context);
  yield* observeWatcherStartup(dependencies);
  if (ready) yield* confirmRouterAcquisition(dependencies);
  yield* dependencies.fileSystem.writeAtomic(
    fallbackConfigFile(dependencies.paths),
    renderTraefikFallbackConfig(),
  );
  yield* dependencies.fileSystem.writeAtomic(
    routingStateFile(dependencies.paths),
    [`http://127.0.0.1:${advertised.http}`, `https://127.0.0.1:${advertised.https}`].join("\n"),
  );
});

const applyError = (app: AppId, cause: unknown): ProxyApplyError =>
  cause instanceof ProxyApplyError
    ? cause
    : new ProxyApplyError({
        message: `Traefik route application failed for ${String(app)}.`,
        proxyId: TRAEFIK_PROXY_ID,
        app: String(app),
        remediation:
          cause instanceof CaError
            ? "Run `lando setup` and resolve the active CertificateAuthority failure, then retry."
            : "Check the global app route-config directory permissions and retry.",
        cause,
      });

const proxyError = (operation: string, cause: unknown): ProxyError =>
  new ProxyError({
    message: `Traefik router ${operation} failed.`,
    proxyId: TRAEFIK_PROXY_ID,
    remediation: "Check the global Traefik service and its route-config directory, then retry.",
    cause,
  });

const mapStartupRevalidationError = (cause: unknown): ProxyError | RouterWatcherError =>
  cause instanceof RouterWatcherError ? cause : proxyError("startup revalidation", cause);

const resolveLiveSocketProxy = Effect.gen(function* () {
  const privilege = yield* Effect.serviceOption(PrivilegeService);
  const processRunner = yield* Effect.serviceOption(ProcessRunner);
  const interaction = yield* Effect.serviceOption(InteractionService);
  return liveSocketProxy({
    privilege: privilege._tag === "Some" ? privilege.value : undefined,
    processRunner: processRunner._tag === "Some" ? processRunner.value : undefined,
    interaction: interaction._tag === "Some" ? interaction.value : undefined,
  });
});

const resolveSocketProxy = (dependencies: TraefikProxyDependencies) =>
  dependencies.socketProxy !== undefined ? Effect.succeed(dependencies.socketProxy) : resolveLiveSocketProxy;

const releaseHelperSockets = Effect.fnUntraced(function* (dependencies: TraefikProxyDependencies) {
  const previous = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
  if (previous?.mode !== "socket-helper" || previous.helperInstalled !== true) return;
  const socketProxy = yield* resolveSocketProxy(dependencies);
  if (socketProxy === undefined) return;
  yield* stopSockets({
    processRunner: socketProxy.processRunner,
    privilege: socketProxy.privilege,
    ...(socketProxy.probeForward === undefined ? {} : { probeForward: socketProxy.probeForward }),
  });
});

const routerListsFromConfig = (router: NonNullable<ProxyConfig["router"]>): TraefikRouterLists => ({
  ...(router.bindAddress === undefined ? {} : { bindAddress: router.bindAddress }),
  ...(router.httpPort === undefined ? {} : { httpPort: router.httpPort }),
  ...(router.httpsPort === undefined ? {} : { httpsPort: router.httpsPort }),
  ...(router.httpFallbacks === undefined ? {} : { httpFallbacks: router.httpFallbacks }),
  ...(router.httpsFallbacks === undefined ? {} : { httpsFallbacks: router.httpsFallbacks }),
});

const routerPinFromConfig = (pin: NonNullable<ProxyConfig["routerPin"]>): TraefikRouterPin => ({
  ...(pin.httpPort === undefined ? {} : { httpPort: pin.httpPort }),
  ...(pin.httpsPort === undefined ? {} : { httpsPort: pin.httpsPort }),
});

export const makeTraefikRouterService = (
  dependencies: TraefikProxyDependencies,
): RouterServiceShape & {
  readonly readAppliedRoutes: (app: AppId) => Effect.Effect<ReadonlyArray<RoutePlan>>;
} => {
  const routes = new Map<string, ReadonlyArray<RoutePlan>>();
  const pendingReload = new Set<string>();
  const applyRoutes = makeRouteApplication(dependencies, routes, pendingReload);
  const reloadWindowsRouter = Effect.fn("TraefikRouter.reloadWindowsRouter")(function* (appKey: string) {
    if (dependencies.paths.platform !== "win32") {
      pendingReload.delete(appKey);
      return;
    }
    const restart = dependencies.globalApp.restartRunningService;
    if (restart === undefined) {
      return yield* Effect.fail(new Error("Global app runtime cannot reload the Windows Traefik router."));
    }
    yield* restart(ServiceName.make(TRAEFIK_PROXY_ID));
    pendingReload.delete(appKey);
  });
  let authorityPorts: AuthorityPorts | undefined;
  let defaultDomain: string | undefined;
  const guardRouterMutation = <A, E>(operation: Effect.Effect<A, E>) =>
    dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined
      ? dependencies.stateStore.withLock(routeReloadLockKey(), operation, {
          timeoutMs: ROUTE_RELOAD_LOCK_WAIT_MS,
        })
      : operation;

  const acquire = Effect.fn("TraefikRouter.acquirePorts")(function* (config: ProxyConfig) {
    yield* dependencies.globalApp.ensureProviderReady ?? Effect.void;
    yield* dependencies.fileSystem.mkdir(dynamicConfigDir(dependencies.paths));
    const socketProxy = yield* resolveSocketProxy(dependencies);
    return yield* persistPortAcquisition({
      ...dependencies,
      ...(socketProxy === undefined ? {} : { socketProxy }),
      ...(config.router === undefined ? {} : { router: routerListsFromConfig(config.router) }),
      ...(config.routerPin === undefined ? {} : { routerPin: routerPinFromConfig(config.routerPin) }),
    });
  });
  return {
    ...RouterService.of({
      id: TRAEFIK_PROXY_ID,
      capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
      observeRoutes: makeRouteObserver(dependencies, pendingReload),
      prepare: Effect.fn("RouterService.prepare")(
        (config) =>
          guardRouterMutation(
            Effect.gen(function* () {
              const decision = yield* acquire(config);
              defaultDomain = normalizeDefaultDomain(config.defaultDomain);
              yield* dependencies.fileSystem.writeAtomic(
                defaultDomainFile(dependencies.paths),
                `${defaultDomain}\n`,
              );
              authorityPorts = advertisedPorts(decision);
              yield* ensureDashboardFile(dependencies, defaultDomain);
            }),
          ),
        Effect.mapError((cause) => {
          const mapped = mapSetupError(cause);
          return mapped instanceof RouterWatcherError
            ? new ProxySetupError({
                message: "Traefik ingress preparation failed.",
                proxyId: TRAEFIK_PROXY_ID,
                remediation: mapped.remediation,
                cause: mapped,
              })
            : mapped;
        }),
      ),
      setup: Effect.fn("RouterService.setup")(
        (config, options) =>
          guardRouterMutation(
            Effect.gen(function* () {
              yield* dependencies.globalApp.ensureProviderReady ?? Effect.void;
              yield* dependencies.fileSystem.mkdir(dynamicConfigDir(dependencies.paths));
              const socketProxy = yield* resolveSocketProxy(dependencies);
              const decision = yield* persistPortAcquisition(
                {
                  ...dependencies,
                  ...(socketProxy === undefined
                    ? {}
                    : {
                        socketProxy:
                          options?.autoApprove === true ? { ...socketProxy, autoApprove: true } : socketProxy,
                      }),
                  ...(config.router === undefined ? {} : { router: routerListsFromConfig(config.router) }),
                  ...(config.routerPin === undefined
                    ? {}
                    : { routerPin: routerPinFromConfig(config.routerPin) }),
                },
                { rescan: options?.reacquirePorts === true },
              );
              defaultDomain = normalizeDefaultDomain(config.defaultDomain);
              yield* dependencies.fileSystem.writeAtomic(
                defaultDomainFile(dependencies.paths),
                `${defaultDomain}\n`,
              );
              const advertised = advertisedPorts(decision);
              authorityPorts = advertised;
              if (decision.notices.length > 0) {
                yield* publishFallbackWarn(dependencies, decision);
              }
              yield* ensureDashboardFile(dependencies, defaultDomain);
              yield* dependencies.globalApp.ensureRunning([TRAEFIK_PROXY_ID, TRAEFIK_DIAGNOSTICS_ID]);
              yield* finalizeRouterStartup(dependencies, advertised, "setup");
            }),
          ),
        Effect.mapError(mapSetupError),
      ),
      revalidateStartup: Effect.fn("RouterService.revalidateStartup")(
        () =>
          guardRouterMutation(
            Effect.gen(function* () {
              const state = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
              const advertised =
                state === undefined
                  ? (authorityPorts ?? DEFAULT_AUTHORITY_PORTS)
                  : { http: state.httpPort, https: state.httpsPort };
              authorityPorts = advertised;
              yield* finalizeRouterStartup(dependencies, advertised, "revalidation");
            }),
          ),
        Effect.mapError(mapStartupRevalidationError),
      )(),
      applyRoutes: Effect.fn("RouterService.applyRoutes")(
        (nextRoutes, app) => {
          const apply = applyRoutes(nextRoutes, app).pipe(
            Effect.tap(() =>
              nextRoutes.length === 0 ? Effect.void : confirmRouterAcquisition(dependencies),
            ),
          );
          const guarded =
            dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined
              ? dependencies.stateStore.withLock(routeReloadLockKey(), apply, {
                  timeoutMs: ROUTE_RELOAD_LOCK_WAIT_MS,
                })
              : apply;
          return guarded;
        },
        (effect, _nextRoutes, app) => effect.pipe(Effect.mapError((cause) => applyError(app, cause))),
      ),
      removeRoutes: Effect.fn("RouterService.removeRoutes")(
        (app) => {
          const remove = Effect.gen(function* () {
            const appKey = String(app);
            const file = routeFile(dependencies.paths, app);
            const hadRouteFile = yield* dependencies.fileSystem.exists(file);
            if (dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined) {
              yield* invalidateAcknowledgement(dependencies.stateStore, app);
            }
            yield* dependencies.fileSystem.remove(file);
            yield* removeAppCertificates(dependencies, app);
            routes.delete(appKey);
            if (hadRouteFile) pendingReload.add(appKey);
            if (pendingReload.has(appKey)) yield* reloadWindowsRouter(appKey);
          });
          const guarded =
            dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined
              ? dependencies.stateStore.withLock(routeReloadLockKey(), remove, {
                  timeoutMs: ROUTE_RELOAD_LOCK_WAIT_MS,
                })
              : remove;
          return guarded;
        },
        Effect.mapError((cause) => proxyError("route removal", cause)),
      ),
      status: Effect.fn("RouterService.status")(
        function* () {
          return yield* persistedStatus(dependencies);
        },
        Effect.mapError((cause) => proxyError("status", cause)),
      )(),
      stop: Effect.fn("RouterService.stop")(
        () => {
          const stop = Effect.gen(function* () {
            yield* releaseHelperSockets(dependencies);
            const directory = dynamicConfigDir(dependencies.paths);
            if (yield* dependencies.fileSystem.exists(directory)) {
              const files = yield* dependencies.fileSystem.readDir(directory);
              yield* Effect.forEach(
                files.filter(
                  (file) => file.startsWith(ROUTE_FILE_PREFIX) && file.endsWith(ROUTE_FILE_SUFFIX),
                ),
                (file) =>
                  Effect.gen(function* () {
                    const encodedApp = file.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length);
                    const routeApp = AppId.make(decodeURIComponent(encodedApp));
                    if (dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined) {
                      yield* invalidateAcknowledgement(dependencies.stateStore, routeApp);
                    }
                    yield* dependencies.fileSystem.remove(joinFor(dependencies.paths)(directory, file));
                  }),
                { discard: true },
              );
            }
            yield* dependencies.fileSystem.remove(routingStateFile(dependencies.paths));
            yield* dependencies.fileSystem.remove(acquisitionStateFile(dependencies.paths));
            yield* dependencies.fileSystem.remove(defaultDomainFile(dependencies.paths));
            yield* dependencies.fileSystem.remove(defaultTlsFile(dependencies.paths));
            yield* dependencies.fileSystem.remove(dashboardConfigFile(dependencies.paths));
            yield* dependencies.fileSystem.remove(fallbackConfigFile(dependencies.paths));
            yield* dependencies.fileSystem.remove(watcherDiagnosticFile(dependencies.paths));
            yield* removeAllCertificates(dependencies);
            routes.clear();
          });
          const guarded =
            dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined
              ? dependencies.stateStore.withLock(routeReloadLockKey(), stop, {
                  timeoutMs: ROUTE_RELOAD_LOCK_WAIT_MS,
                })
              : stop;
          return guarded;
        },
        Effect.mapError((cause) => proxyError("stop", cause)),
      )(),
    }),
    readAppliedRoutes: (app: AppId) => Effect.succeed(routes.get(String(app)) ?? []),
  };
};

export const layer = (stateStore: PluginStateStore) =>
  Layer.effect(
    RouterService,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem;
      const paths = yield* PathsService;
      const globalApp = yield* GlobalAppService;
      const certificateAuthority = yield* CertificateAuthority;
      const events = yield* Effect.serviceOption(EventService);
      const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
      const socketProxy = yield* resolveLiveSocketProxy;
      const httpClient = yield* HttpClient.HttpClient;
      return makeTraefikRouterService({
        httpClient,
        certificateAuthority,
        fileSystem: {
          ...fileSystem,
          writeSecretAtomic: (path, content) => Effect.tryPromise(() => writeSecretAtomic(path, content)),
        },
        paths,
        globalApp,
        stateStore,
        ...(socketProxy === undefined ? {} : { socketProxy }),
        ...(events._tag === "Some" ? { events: events.value } : {}),
        ...Option.match(registry, {
          onNone: () => ({}),
          onSome: (registry) => ({
            readTraefikPublications: Effect.fn("TraefikRouter.readTraefikPublications")(function* () {
              const provider = yield* registry.select(yield* globalApp.providerId);
              const service = yield* provider.inspect({
                app: AppId.make("global"),
                service: ServiceName.make("traefik"),
              });
              return (service.state ?? service.status).toLowerCase() === "running"
                ? service.publications
                : { status: "unknown" as const };
            }),
            readTraefikLogs: Effect.fn("TraefikRouter.readTraefikLogs")(function* () {
              const provider = yield* registry.select(yield* globalApp.providerId);
              if (provider.capabilities.serviceLogs !== true) {
                return yield* Effect.fail(proxyError("log observation", "Service logs are unavailable."));
              }
              const chunks = yield* provider
                .logs(
                  { app: AppId.make("global"), service: ServiceName.make("traefik") },
                  { follow: false, tail: 200 },
                )
                .pipe(Stream.runCollect);
              return {
                providerId: provider.id,
                text: Array.from(chunks, (chunk) => chunk.line).join("\n"),
              };
            }),
          }),
        }),
      });
    }),
  );

export { TRAEFIK_DYNAMIC_CONFIG_SOURCE };
