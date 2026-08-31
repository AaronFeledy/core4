import { Effect, Layer } from "effect";

import { CaError, ProxyApplyError, ProxyError } from "@lando/sdk/errors";
import type { AppId, ProxyApplyResult, ProxyConfig, RoutePlan } from "@lando/sdk/schema";
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
} from "@lando/sdk/services";

import { persistPortAcquisition, readAcquisitionState } from "./port-acquisition-state.ts";
import {
  ROUTE_FILE_PREFIX,
  ROUTE_FILE_SUFFIX,
  acquisitionStateFile,
  defaultTlsFile,
  dynamicConfigDir,
  joinFor,
  routeFile,
  routingStateFile,
} from "./proxy-paths.ts";
import { advertisedPorts, mapSetupError, publishFallbackWarn } from "./proxy-setup.ts";
import type { TraefikProxyDependencies, TraefikRouterLists, TraefikRouterPin } from "./proxy-types.ts";
import { DEFAULT_AUTHORITY_PORTS, authoritiesFor, renderTraefikDynamicConfig } from "./routing.ts";
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

export { renderTraefikDynamicConfig } from "./routing.ts";

const TRAEFIK_PROXY_ID = "traefik";
const TRAEFIK_DYNAMIC_CONFIG_SOURCE = "./proxy-traefik/dynamic";

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
        yield* dependencies.globalApp.ensureRunning([TRAEFIK_PROXY_ID]);
        yield* dependencies.fileSystem.writeAtomic(
          routingStateFile(dependencies.paths),
          [`http://127.0.0.1:${advertised.http}`, `https://127.0.0.1:${advertised.https}`].join("\n"),
        );
      }).pipe(Effect.mapError(mapSetupError)),
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
      yield* dependencies.fileSystem.remove(defaultTlsFile(dependencies.paths));
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
    });
  }),
);

export { TRAEFIK_DYNAMIC_CONFIG_SOURCE };
