import type { AppRouteOwner, RoutePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import { Clock, Effect } from "effect";
import { ensureDashboardFile, renderTraefikDashboardConfig } from "./dashboard.ts";
import { readAcquisitionState } from "./port-acquisition-state.ts";
import {
  TRAEFIK_CONTAINER_CERTIFICATE_DIR,
  defaultCertificateNames,
  defaultDomainFile,
  routeFile,
} from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { acceptanceError, awaitRouteAcceptance, requireRouteAcceptance } from "./route-acceptance.ts";
import { requireOwnedRouteFile } from "./route-file-ownership.ts";
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
import {
  defaultCertificateHostnames,
  httpsHostnames,
  normalizeDefaultDomain,
  prepareTlsFiles,
  removeAppCertificates,
} from "./tls.ts";

export const makeRouteApplication = (
  dependencies: TraefikProxyDependencies,
  routes: Map<string, ReadonlyArray<RoutePlan>>,
  pendingReload: Set<string>,
) =>
  Effect.fn("TraefikRouter.applyRoutes")(function* (
    nextRoutes: ReadonlyArray<RoutePlan>,
    owner: AppRouteOwner,
  ) {
    const app = owner.id;
    yield* requireOwnedRouteFile(dependencies, owner);
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
    const appKey = owner.ownerKey;
    const file = routeFile(dependencies.paths, owner);
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
      if (windowsStore !== undefined) yield* invalidateAcknowledgement(windowsStore, appKey);
      yield* Effect.uninterruptible(dependencies.fileSystem.remove(file));
      yield* removeAppCertificates(dependencies, owner);
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
    const root =
      hostnames.length === 0 ? undefined : (yield* dependencies.certificateAuthority.root).certificate;
    const expectedTls =
      hostnames.length === 0
        ? undefined
        : {
            certFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${appKey}.crt`,
            keyFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${appKey}.key`,
          };
    const snapshot = yield* routeReloadSnapshot(dependencies, owner, domain);
    const [persistedConfig, certificate, privateKey, defaultCertificate, defaultPrivateKey] = snapshot;
    const now = yield* Clock.currentTimeMillis;
    const appCurrent =
      root === undefined
        ? certificate === undefined && privateKey === undefined
        : certificate !== undefined &&
          privateKey !== undefined &&
          certificatePairIsCurrent(certificate, privateKey, {
            hostnames,
            now,
            root,
          });
    const defaultCurrent =
      root === undefined ||
      (defaultCertificate !== undefined &&
        defaultPrivateKey !== undefined &&
        certificatePairIsCurrent(defaultCertificate, defaultPrivateKey, {
          hostnames: defaultCertificateHostnames(domain),
          now,
          root,
        }));
    const tls =
      root === undefined
        ? undefined
        : yield* prepareTlsFiles(dependencies, {
            owner,
            defaultDomain: domain,
            hostnames,
            refreshAppCertificate: !appCurrent,
            refreshDefaultCertificate: !defaultCurrent,
            root,
          });
    const expectedConfig =
      renderTraefikDynamicConfig(nextRoutes, owner, expectedTls) +
      (tls === undefined
        ? ""
        : `# lando-certificate-generation: ${routeReloadDigest([
            tls.appCertificate ?? certificate,
            tls.defaultCertificate ?? defaultCertificate,
          ])}\n`);
    const defaultNames = defaultCertificateNames(domain);
    const tlsCurrent =
      hostnames.length === 0 ||
      snapshot[5] ===
        renderTraefikDefaultTlsConfig({
          certFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${defaultNames.cert}`,
          keyFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${defaultNames.key}`,
        });
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
        ? yield* isAcknowledged(windowsStore, appKey, routeReloadDigest(snapshot))
        : routes.has(appKey) && !pendingReload.has(appKey));
    yield* Effect.gen(function* () {
      pendingReload.add(appKey);
      if (windowsStore !== undefined && !warmAcknowledged)
        yield* invalidateAcknowledgement(windowsStore, appKey);
      if (!unchanged) {
        yield* ensureDashboardFile(dependencies, domain);
        if (hostnames.length === 0) yield* removeAppCertificates(dependencies, owner);
      }
      if (tls !== undefined) yield* tls.publish;
      // Traefik watches top-level YAML; nested PEM replacement alone does not reload it.
      if (persistedConfig !== expectedConfig || !appCurrent || !defaultCurrent)
        yield* dependencies.fileSystem.writeAtomic(file, expectedConfig);
    }).pipe(Effect.uninterruptible);
    if (dependencies.paths.platform === "win32" && !warmAcknowledged) {
      const before = routeReloadDigest(yield* routeReloadSnapshot(dependencies, owner, domain));
      yield* restart;
      if (routeReloadDigest(yield* routeReloadSnapshot(dependencies, owner, domain)) !== before) {
        return yield* Effect.fail(acceptanceError(app, "generation-changed"));
      }
      yield* awaitRouteAcceptance(dependencies, owner, nextRoutes);
      if (routeReloadDigest(yield* routeReloadSnapshot(dependencies, owner, domain)) !== before) {
        return yield* Effect.fail(acceptanceError(app, "generation-changed"));
      }
      if (windowsStore !== undefined) yield* acknowledge(windowsStore, appKey, before);
    } else {
      yield* awaitRouteAcceptance(dependencies, owner, nextRoutes);
      if (
        warmAcknowledged &&
        routeReloadDigest(yield* routeReloadSnapshot(dependencies, owner, domain)) !==
          routeReloadDigest(snapshot)
      ) {
        return yield* Effect.fail(acceptanceError(app, "generation-changed"));
      }
    }
    pendingReload.delete(appKey);
    routes.set(appKey, nextRoutes);
    return { app, appliedRoutes: nextRoutes, authorities: authoritiesFor(nextRoutes, ports) };
  });
