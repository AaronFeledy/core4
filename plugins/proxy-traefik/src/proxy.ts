import { DateTime, Effect, Layer, Option, Stream } from "effect";

import { CaError, ProxyApplyError, ProxyError, ProxySetupError, RouterWatcherError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  type ProxyApplyResult,
  type ProxyConfig,
  type RoutePlan,
  ServiceName,
} from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
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

import { TRAEFIK_DIAGNOSTICS_ID, renderTraefikFallbackConfig } from "./diagnostics.ts";
import { prepareTraefikDiagnostics } from "./global-services/diagnostics.ts";
import { persistPortAcquisition, readAcquisitionState } from "./port-acquisition-state.ts";
import {
  ROUTE_FILE_PREFIX,
  ROUTE_FILE_SUFFIX,
  TRAEFIK_CONTAINER_CERTIFICATE_DIR,
  acquisitionStateFile,
  appCertificateFiles,
  defaultCertificateFiles,
  defaultTlsFile,
  diagnosticConfigFile,
  diagnosticHtmlFile,
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
import {
  acknowledge,
  certificatePairIsCurrent,
  invalidateAcknowledgement,
  isAcknowledged,
  routeReloadDigest,
  routeReloadLockKey,
} from "./route-reload-state.ts";
import {
  type AuthorityPorts,
  DEFAULT_AUTHORITY_PORTS,
  authoritiesFor,
  renderTraefikDynamicConfig,
} from "./routing.ts";
import { writeSecretAtomic } from "./secret-file.ts";
import { stopSockets } from "./socket-proxy-install.ts";
import { liveSocketProxy } from "./socket-proxy-setup.ts";
import { persistedStatus } from "./status.ts";
import {
  ensureTlsFiles,
  httpsHostnames,
  normalizeDefaultDomain,
  removeAllCertificates,
  removeAppCertificates,
} from "./tls.ts";
import { clearWatcherDiagnostic, writeWatcherDiagnostic } from "./watcher-diagnostic-state.ts";
import {
  boundWatcherDetail,
  classifyWatcherFailure,
  watcherHostLabel,
  watcherRemediations,
} from "./watcher-diagnostics.ts";

export { renderTraefikDynamicConfig } from "./routing.ts";

const TRAEFIK_PROXY_ID = "traefik";
const TRAEFIK_DYNAMIC_CONFIG_SOURCE = "./proxy-traefik/dynamic";
const secretsRedactor = createRedactor("secrets");

/**
 * Selecting a provider reads only `plan.provider`. The host-level global app that
 * runs Traefik is always applied with the Lando-managed provider, regardless of a
 * user `defaultProviderId`, so the log observation pins the same provider. If that
 * provider is not installed the selection fails and the observation is skipped.
 */
const GLOBAL_LOG_SELECT_PLAN: AppPlan = {
  id: AppId.make("global"),
  name: "global",
  slug: "global",
  root: AbsolutePath.make("/"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("1970-01-01T00:00:00.000Z"),
    source: "global-app",
    runtime: 4,
  },
  extensions: {},
};

const observeWatcherStartup = (dependencies: TraefikProxyDependencies) =>
  Effect.gen(function* () {
    if (dependencies.readTraefikLogs === undefined) return;
    const observation = Option.getOrUndefined(yield* Effect.option(dependencies.readTraefikLogs()));
    if (observation === undefined) return;
    const hit = classifyWatcherFailure(observation.text);
    if (hit === undefined) {
      yield* clearWatcherDiagnostic(dependencies.fileSystem, dependencies.paths);
      return;
    }
    const redact = dependencies.redactDiagnostic ?? secretsRedactor.redactString;
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
      observedAt: new Date().toISOString(),
      providerId: observation.providerId,
      watcherHost,
      failureClass: hit.failureClass,
      detail,
    }).pipe(Effect.catchAll(() => Effect.void));
    yield* dependencies.fileSystem
      .remove(routingStateFile(dependencies.paths))
      .pipe(Effect.catchAll(() => Effect.void));
    return yield* Effect.fail(error);
  });

// observeWatcherStartup removes .lando-routing-state on failure; persistedStatus
// reports stopped without it. Every successful observation must rewrite the
// fallback config and routing marker together.
const finalizeRouterStartup = (dependencies: TraefikProxyDependencies, advertised: AuthorityPorts) =>
  Effect.gen(function* () {
    yield* assertAdvertisedForward(dependencies, advertised);
    yield* observeWatcherStartup(dependencies);
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
  new ProxyApplyError({
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

const releaseHelperSockets = (dependencies: TraefikProxyDependencies) =>
  Effect.gen(function* () {
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

const persistedTlsFiles = (app: AppId) => {
  const encoded = encodeURIComponent(String(app));
  return {
    certFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${encoded}.crt`,
    keyFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${encoded}.key`,
  };
};

const readOptional = (dependencies: TraefikProxyDependencies, path: string) =>
  dependencies.fileSystem
    .exists(path)
    .pipe(
      Effect.flatMap((exists) =>
        exists ? dependencies.fileSystem.readText(path) : Effect.succeed(undefined),
      ),
    );

const routeReloadSnapshot = (dependencies: TraefikProxyDependencies, app: AppId, defaultDomain: string) => {
  const certificates = appCertificateFiles(dependencies.paths, app);
  const defaults = defaultCertificateFiles(dependencies.paths, defaultDomain);
  return Effect.all([
    readOptional(dependencies, routeFile(dependencies.paths, app)),
    readOptional(dependencies, certificates.cert),
    readOptional(dependencies, certificates.key),
    readOptional(dependencies, defaults.cert),
    readOptional(dependencies, defaults.key),
    readOptional(dependencies, defaultTlsFile(dependencies.paths)),
  ]);
};
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
  const reloadWindowsRouter = (appKey: string) =>
    Effect.gen(function* () {
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
  let authorityPorts = DEFAULT_AUTHORITY_PORTS;
  let defaultDomain = "lndo.site";

  const acquire = (config: ProxyConfig) =>
    Effect.gen(function* () {
      if (dependencies.paths.platform === "win32") {
        yield* dependencies.globalApp.ensureProviderReady ?? Effect.void;
      }
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
    id: TRAEFIK_PROXY_ID,
    capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
    prepare: (config) =>
      acquire(config).pipe(
        Effect.tap((decision) =>
          Effect.sync(() => {
            defaultDomain = normalizeDefaultDomain(config.defaultDomain);
            authorityPorts = advertisedPorts(decision);
          }),
        ),
        Effect.asVoid,
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
    setup: (config, options) =>
      Effect.gen(function* () {
        defaultDomain = normalizeDefaultDomain(config.defaultDomain);
        if (dependencies.paths.platform === "win32") {
          yield* dependencies.globalApp.ensureProviderReady ?? Effect.void;
        }
        yield* dependencies.fileSystem.mkdir(dynamicConfigDir(dependencies.paths));
        const socketProxy = yield* resolveSocketProxy(dependencies);
        const decision = yield* persistPortAcquisition({
          ...dependencies,
          ...(socketProxy === undefined
            ? {}
            : {
                socketProxy:
                  options?.autoApprove === true ? { ...socketProxy, autoApprove: true } : socketProxy,
              }),
          ...(config.router === undefined ? {} : { router: routerListsFromConfig(config.router) }),
          ...(config.routerPin === undefined ? {} : { routerPin: routerPinFromConfig(config.routerPin) }),
        });
        const advertised = advertisedPorts(decision);
        authorityPorts = advertised;
        if (decision.notices.length > 0) {
          yield* publishFallbackWarn(dependencies, decision);
        }
        yield* prepareTraefikDiagnostics(dependencies);
        yield* dependencies.globalApp.ensureRunning([TRAEFIK_PROXY_ID, TRAEFIK_DIAGNOSTICS_ID]);
        yield* finalizeRouterStartup(dependencies, advertised);
      }).pipe(Effect.mapError(mapSetupError)),
    revalidateStartup: Effect.gen(function* () {
      const state = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
      const advertised =
        state === undefined ? authorityPorts : { http: state.httpPort, https: state.httpsPort };
      authorityPorts = advertised;
      yield* finalizeRouterStartup(dependencies, advertised);
    }).pipe(Effect.mapError(mapStartupRevalidationError)),
    applyRoutes: (nextRoutes, app) => {
      const apply = Effect.gen(function* () {
        const appKey = String(app);
        const file = routeFile(dependencies.paths, app);
        const hadRouteFile = yield* dependencies.fileSystem.exists(file);
        if (nextRoutes.length === 0) {
          if (dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined) {
            yield* invalidateAcknowledgement(dependencies.stateStore, app);
          }
          yield* dependencies.fileSystem.remove(file);
          yield* removeAppCertificates(dependencies, app);
          routes.delete(appKey);
          if (hadRouteFile) pendingReload.add(appKey);
        } else {
          const hostnames = httpsHostnames(nextRoutes);
          const expectedTls = hostnames.length === 0 ? undefined : persistedTlsFiles(app);
          const expectedConfig = renderTraefikDynamicConfig(nextRoutes, app, expectedTls);
          if (dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined) {
            const snapshot = yield* routeReloadSnapshot(dependencies, app, defaultDomain);
            const [persistedConfig, certificate, privateKey, defaultCertificate, defaultPrivateKey] =
              snapshot;
            const digest = routeReloadDigest(snapshot);
            const appCertificateCurrent =
              hostnames.length === 0
                ? certificate === undefined && privateKey === undefined
                : certificate !== undefined &&
                  privateKey !== undefined &&
                  certificatePairIsCurrent(certificate, privateKey, hostnames);
            const defaultCertificateCurrent =
              hostnames.length === 0 ||
              (defaultCertificate !== undefined &&
                defaultPrivateKey !== undefined &&
                certificatePairIsCurrent(defaultCertificate, defaultPrivateKey, [
                  `test.${defaultDomain}`,
                  defaultDomain,
                  "traefik.lndo.site",
                ]));
            if (
              persistedConfig === expectedConfig &&
              appCertificateCurrent &&
              defaultCertificateCurrent &&
              (yield* isAcknowledged(dependencies.stateStore, app, digest))
            ) {
              routes.set(appKey, nextRoutes);
              return {
                app,
                appliedRoutes: nextRoutes,
                authorities: authoritiesFor(nextRoutes, authorityPorts),
              } satisfies ProxyApplyResult;
            }
          }

          if (dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined) {
            yield* invalidateAcknowledgement(dependencies.stateStore, app);
          }
          if (dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined) {
            pendingReload.add(appKey);
          }
          const previousHostnames = httpsHostnames(routes.get(appKey) ?? []);
          const appCertificate = appCertificateFiles(dependencies.paths, app);
          const defaultCertificate = defaultCertificateFiles(dependencies.paths, defaultDomain);
          const appCertificatePem = yield* readOptional(dependencies, appCertificate.cert);
          const appPrivateKeyPem = yield* readOptional(dependencies, appCertificate.key);
          const defaultCertificatePem = yield* readOptional(dependencies, defaultCertificate.cert);
          const defaultPrivateKeyPem = yield* readOptional(dependencies, defaultCertificate.key);
          const appCertificateCurrent =
            hostnames.length === 0 ||
            (appCertificatePem !== undefined &&
              appPrivateKeyPem !== undefined &&
              certificatePairIsCurrent(appCertificatePem, appPrivateKeyPem, hostnames));
          const defaultCertificateCurrent =
            hostnames.length === 0 ||
            (defaultCertificatePem !== undefined &&
              defaultPrivateKeyPem !== undefined &&
              certificatePairIsCurrent(defaultCertificatePem, defaultPrivateKeyPem, [
                `test.${defaultDomain}`,
                defaultDomain,
                "traefik.lndo.site",
              ]));
          const refreshAppCertificate =
            hostnames.join("\n") !== previousHostnames.join("\n") || !appCertificateCurrent;
          const refreshDefaultCertificate = !defaultCertificateCurrent;
          const missingCertificate =
            hostnames.length > 0 && (!appCertificateCurrent || !defaultCertificateCurrent);
          if (hostnames.length === 0) yield* removeAppCertificates(dependencies, app);
          const tlsFiles =
            hostnames.length === 0
              ? undefined
              : yield* ensureTlsFiles(dependencies, {
                  app,
                  defaultDomain,
                  hostnames,
                  refreshAppCertificate,
                  refreshDefaultCertificate,
                });
          const nextConfig = renderTraefikDynamicConfig(nextRoutes, app, tlsFiles);
          const previousConfig = hadRouteFile ? yield* dependencies.fileSystem.readText(file) : undefined;
          if (previousConfig !== nextConfig || refreshAppCertificate || missingCertificate) {
            yield* dependencies.fileSystem.writeAtomic(file, nextConfig);
            pendingReload.add(appKey);
          }
          routes.set(appKey, nextRoutes);
        }
        if (pendingReload.has(appKey)) {
          if (dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined) {
            const before = yield* routeReloadSnapshot(dependencies, app, defaultDomain);
            const digest = routeReloadDigest(before);
            yield* reloadWindowsRouter(appKey);
            const after = yield* routeReloadSnapshot(dependencies, app, defaultDomain);
            if (routeReloadDigest(after) !== digest) {
              return yield* Effect.fail(
                new Error("Traefik route files changed while the Windows router reloaded."),
              );
            }
            yield* acknowledge(dependencies.stateStore, app, digest);
          } else {
            yield* reloadWindowsRouter(appKey);
          }
        }
        return {
          app,
          appliedRoutes: nextRoutes,
          authorities: authoritiesFor(nextRoutes, authorityPorts),
        } satisfies ProxyApplyResult;
      });
      const guarded =
        dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined
          ? dependencies.stateStore.withLock(routeReloadLockKey(), apply)
          : apply;
      return guarded.pipe(Effect.mapError((cause) => applyError(app, cause)));
    },
    removeRoutes: (app) => {
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
          ? dependencies.stateStore.withLock(routeReloadLockKey(), remove)
          : remove;
      return guarded.pipe(Effect.mapError((cause) => proxyError("route removal", cause)));
    },
    status: persistedStatus(dependencies).pipe(Effect.mapError((cause) => proxyError("status", cause))),
    stop: (() => {
      const stop = Effect.gen(function* () {
        yield* releaseHelperSockets(dependencies);
        const directory = dynamicConfigDir(dependencies.paths);
        if (yield* dependencies.fileSystem.exists(directory)) {
          const files = yield* dependencies.fileSystem.readDir(directory);
          yield* Effect.forEach(
            files.filter((file) => file.startsWith(ROUTE_FILE_PREFIX) && file.endsWith(ROUTE_FILE_SUFFIX)),
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
        yield* dependencies.fileSystem.remove(defaultTlsFile(dependencies.paths));
        yield* dependencies.fileSystem.remove(fallbackConfigFile(dependencies.paths));
        yield* dependencies.fileSystem.remove(diagnosticConfigFile(dependencies.paths));
        yield* dependencies.fileSystem.remove(diagnosticHtmlFile(dependencies.paths));
        yield* dependencies.fileSystem.remove(watcherDiagnosticFile(dependencies.paths));
        yield* removeAllCertificates(dependencies);
        routes.clear();
      });
      const guarded =
        dependencies.paths.platform === "win32" && dependencies.stateStore !== undefined
          ? dependencies.stateStore.withLock(routeReloadLockKey(), stop)
          : stop;
      return guarded.pipe(Effect.mapError((cause) => proxyError("stop", cause)));
    })(),
    readAppliedRoutes: (app) => Effect.succeed(routes.get(String(app)) ?? []),
  };
};

export const makeProxyLayer = (stateStore: PluginStateStore) =>
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
      return makeTraefikRouterService({
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
            readTraefikLogs: () =>
              Effect.gen(function* () {
                const provider = yield* registry.select(GLOBAL_LOG_SELECT_PLAN);
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
