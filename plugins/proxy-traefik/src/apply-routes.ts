import type { AppId, RoutePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import { Clock, Effect } from "effect";
import { ensureDashboardFile, renderTraefikDashboardConfig } from "./dashboard.ts";
import { readAcquisitionState } from "./port-acquisition-state.ts";
import {
  TRAEFIK_CONTAINER_CERTIFICATE_DIR,
  defaultCertificateNames,
  defaultDomainFile,
  defaultIssuerFile,
  routeFile,
} from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { acceptanceError, awaitRouteAcceptance, requireRouteAcceptance } from "./route-acceptance.ts";
import { routeReloadSnapshot } from "./route-reload-snapshot.ts";
import {
  acknowledge,
  certificatePairIsCurrent,
  invalidateAcknowledgement,
  isAcknowledged,
  routeReloadDigest,
} from "./route-reload-state.ts";
import {
  DEFAULT_AUTHORITY_PORTS,
  authoritiesFor,
  renderTraefikDefaultTlsConfig,
  renderTraefikDynamicConfig,
} from "./routing.ts";
import { ensureTlsFiles, httpsHostnames, normalizeDefaultDomain, removeAppCertificates } from "./tls.ts";

export const makeRouteApplication = (
  dependencies: TraefikProxyDependencies,
  routes: Map<string, ReadonlyArray<RoutePlan>>,
  pendingReload: Set<string>,
) =>
  Effect.fn("TraefikRouter.applyRoutes")(function* (nextRoutes: ReadonlyArray<RoutePlan>, app: AppId) {
    if (nextRoutes.length > 0) yield* requireRouteAcceptance(dependencies, app);
    const acquisition = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
    const ports =
      acquisition === undefined
        ? DEFAULT_AUTHORITY_PORTS
        : { http: acquisition.httpPort, https: acquisition.httpsPort };
    const persistedDomain = yield* dependencies.fileSystem
      .readText(defaultDomainFile(dependencies.paths))
      .pipe(Effect.catch(() => Effect.succeed("")));
    const domain = normalizeDefaultDomain(persistedDomain) || "lndo.site";
    const appKey = String(app);
    const file = routeFile(dependencies.paths, app);
    const windowsStore = dependencies.paths.platform === "win32" ? dependencies.stateStore : undefined;
    const restart = Effect.gen(function* () {
      if (dependencies.paths.platform !== "win32") return;
      const restartService = dependencies.globalApp.restartRunningService;
      if (restartService === undefined || !(yield* restartService(ServiceName.make("traefik")))) {
        return yield* Effect.fail(acceptanceError(app, "restart-unavailable"));
      }
    });
    if (nextRoutes.length === 0) {
      yield* ensureDashboardFile(dependencies, domain);
      const hadFile = yield* dependencies.fileSystem.exists(file);
      if (windowsStore !== undefined) yield* invalidateAcknowledgement(windowsStore, app);
      yield* Effect.uninterruptible(dependencies.fileSystem.remove(file));
      yield* removeAppCertificates(dependencies, app);
      routes.delete(appKey);
      if (hadFile) pendingReload.add(appKey);
      if (pendingReload.has(appKey)) {
        if (dependencies.paths.platform === "win32") {
          const restartService = dependencies.globalApp.restartRunningService;
          if (restartService === undefined)
            return yield* Effect.fail(acceptanceError(app, "restart-unavailable"));
          yield* restartService(ServiceName.make("traefik"));
        }
        pendingReload.delete(appKey);
      }
      return { app, appliedRoutes: nextRoutes, authorities: authoritiesFor(nextRoutes, ports) };
    }
    const hostnames = httpsHostnames(nextRoutes);
    const encoded = encodeURIComponent(appKey);
    const expectedTls =
      hostnames.length === 0
        ? undefined
        : {
            certFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${encoded}.crt`,
            keyFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${encoded}.key`,
          };
    const expectedConfig = renderTraefikDynamicConfig(nextRoutes, app, expectedTls);
    const snapshot = yield* routeReloadSnapshot(dependencies, app, domain);
    const [persistedConfig, certificate, privateKey, defaultCertificate, defaultPrivateKey] = snapshot;
    const now = yield* Clock.currentTimeMillis;
    const appCurrent =
      hostnames.length === 0
        ? certificate === undefined && privateKey === undefined
        : certificate !== undefined &&
          privateKey !== undefined &&
          certificatePairIsCurrent(certificate, privateKey, hostnames, now);
    const defaultCurrent =
      hostnames.length === 0 ||
      (defaultCertificate !== undefined &&
        defaultPrivateKey !== undefined &&
        certificatePairIsCurrent(
          defaultCertificate,
          defaultPrivateKey,
          [`test.${domain}`, domain, `traefik.${domain}`],
          now,
        ));
    const defaultNames = defaultCertificateNames(domain);
    const tlsCurrent =
      hostnames.length === 0 ||
      (snapshot[5] ===
        renderTraefikDefaultTlsConfig({
          certFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${defaultNames.cert}`,
          keyFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${defaultNames.key}`,
        }) &&
        (yield* dependencies.fileSystem.exists(defaultIssuerFile(dependencies.paths, domain))));
    const unchanged =
      persistedConfig === expectedConfig &&
      appCurrent &&
      defaultCurrent &&
      tlsCurrent &&
      snapshot[6] === renderTraefikDashboardConfig(domain);
    const warmAcknowledged =
      dependencies.paths.platform === "win32" &&
      unchanged &&
      (windowsStore !== undefined
        ? yield* isAcknowledged(windowsStore, app, routeReloadDigest(snapshot))
        : routes.has(appKey) && !pendingReload.has(appKey));
    pendingReload.add(appKey);
    if (windowsStore !== undefined && !warmAcknowledged) yield* invalidateAcknowledgement(windowsStore, app);
    if (!unchanged) {
      yield* ensureDashboardFile(dependencies, domain);
      if (hostnames.length === 0) yield* removeAppCertificates(dependencies, app);
      const tls =
        hostnames.length === 0
          ? undefined
          : yield* ensureTlsFiles(dependencies, {
              app,
              defaultDomain: domain,
              hostnames,
              refreshAppCertificate: !appCurrent,
              refreshDefaultCertificate: !defaultCurrent,
            });
      const config = renderTraefikDynamicConfig(nextRoutes, app, tls);
      if (persistedConfig !== config) yield* dependencies.fileSystem.writeAtomic(file, config);
    }
    if (dependencies.paths.platform === "win32" && !warmAcknowledged) {
      const before = routeReloadDigest(yield* routeReloadSnapshot(dependencies, app, domain));
      yield* restart;
      if (routeReloadDigest(yield* routeReloadSnapshot(dependencies, app, domain)) !== before) {
        return yield* Effect.fail(acceptanceError(app, "generation-changed"));
      }
      yield* awaitRouteAcceptance(dependencies, app, nextRoutes);
      if (routeReloadDigest(yield* routeReloadSnapshot(dependencies, app, domain)) !== before) {
        return yield* Effect.fail(acceptanceError(app, "generation-changed"));
      }
      if (windowsStore !== undefined) yield* acknowledge(windowsStore, app, before);
    } else {
      yield* awaitRouteAcceptance(dependencies, app, nextRoutes);
      if (
        warmAcknowledged &&
        routeReloadDigest(yield* routeReloadSnapshot(dependencies, app, domain)) !==
          routeReloadDigest(snapshot)
      ) {
        return yield* Effect.fail(acceptanceError(app, "generation-changed"));
      }
    }
    pendingReload.delete(appKey);
    routes.set(appKey, nextRoutes);
    return { app, appliedRoutes: nextRoutes, authorities: authoritiesFor(nextRoutes, ports) };
  });
