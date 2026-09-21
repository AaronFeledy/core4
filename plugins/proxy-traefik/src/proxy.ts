import { DateTime, Effect, Layer, Option, Stream } from "effect";

import { CaError, ProxyApplyError, ProxyError, RouterWatcherError } from "@lando/sdk/errors";
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
  acquisitionStateFile,
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
  let authorityPorts = DEFAULT_AUTHORITY_PORTS;
  let defaultDomain = "lndo.site";

  return {
    id: TRAEFIK_PROXY_ID,
    capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
    setup: (config) =>
      Effect.gen(function* () {
        defaultDomain = normalizeDefaultDomain(config.defaultDomain);
        yield* dependencies.fileSystem.mkdir(dynamicConfigDir(dependencies.paths));
        const socketProxy = yield* resolveSocketProxy(dependencies);
        const decision = yield* persistPortAcquisition({
          ...dependencies,
          ...(socketProxy === undefined ? {} : { socketProxy }),
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
    applyRoutes: (nextRoutes, app) =>
      Effect.gen(function* () {
        const appKey = String(app);
        if (nextRoutes.length === 0) {
          yield* dependencies.fileSystem.remove(routeFile(dependencies.paths, app));
          yield* removeAppCertificates(dependencies, app);
          routes.delete(appKey);
        } else {
          const hostnames = httpsHostnames(nextRoutes);
          const previousHostnames = httpsHostnames(routes.get(appKey) ?? []);
          if (hostnames.length === 0) yield* removeAppCertificates(dependencies, app);
          const tlsFiles =
            hostnames.length === 0
              ? undefined
              : yield* ensureTlsFiles(dependencies, {
                  app,
                  defaultDomain,
                  hostnames,
                  refreshAppCertificate: hostnames.join("\n") !== previousHostnames.join("\n"),
                });
          yield* dependencies.fileSystem.writeAtomic(
            routeFile(dependencies.paths, app),
            renderTraefikDynamicConfig(nextRoutes, app, tlsFiles),
          );
          routes.set(appKey, nextRoutes);
        }
        return {
          app,
          appliedRoutes: nextRoutes,
          authorities: authoritiesFor(nextRoutes, authorityPorts),
        } satisfies ProxyApplyResult;
      }).pipe(Effect.mapError((cause) => applyError(app, cause))),
    removeRoutes: (app) =>
      Effect.all(
        [
          dependencies.fileSystem.remove(routeFile(dependencies.paths, app)),
          removeAppCertificates(dependencies, app),
        ],
        { discard: true },
      ).pipe(
        Effect.tap(() => Effect.sync(() => void routes.delete(String(app)))),
        Effect.mapError((cause) => proxyError("route removal", cause)),
      ),
    status: persistedStatus(dependencies).pipe(Effect.mapError((cause) => proxyError("status", cause))),
    stop: Effect.gen(function* () {
      yield* releaseHelperSockets(dependencies);
      const directory = dynamicConfigDir(dependencies.paths);
      if (yield* dependencies.fileSystem.exists(directory)) {
        const files = yield* dependencies.fileSystem.readDir(directory);
        yield* Effect.forEach(
          files.filter((file) => file.startsWith(ROUTE_FILE_PREFIX) && file.endsWith(ROUTE_FILE_SUFFIX)),
          (file) => dependencies.fileSystem.remove(joinFor(dependencies.paths)(directory, file)),
          { discard: true },
        );
      }
      yield* dependencies.fileSystem.remove(routingStateFile(dependencies.paths));
      yield* dependencies.fileSystem.remove(acquisitionStateFile(dependencies.paths));
      yield* dependencies.fileSystem.remove(watcherDiagnosticFile(dependencies.paths));
      yield* dependencies.fileSystem.remove(defaultTlsFile(dependencies.paths));
      yield* dependencies.fileSystem.remove(fallbackConfigFile(dependencies.paths));
      yield* dependencies.fileSystem.remove(diagnosticConfigFile(dependencies.paths));
      yield* dependencies.fileSystem.remove(diagnosticHtmlFile(dependencies.paths));
      yield* removeAllCertificates(dependencies);
      routes.clear();
    }).pipe(Effect.mapError((cause) => proxyError("stop", cause))),
    readAppliedRoutes: (app) => Effect.succeed(routes.get(String(app)) ?? []),
  };
};

export const proxy = Layer.effect(
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
