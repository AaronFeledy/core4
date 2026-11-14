import type { AppRouteOwner, RoutePlan } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { ensureDashboardFile, renderTraefikDashboardConfig } from "./dashboard.ts";
import { readAcquisitionState } from "./port-acquisition-state.ts";
import {
  TRAEFIK_CONTAINER_CERTIFICATE_DIR,
  defaultDomainFile,
  defaultIssuerFile,
  routeFile,
} from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { publishRoutes } from "./publish-routes.ts";
import { acceptanceError, awaitRouteAcceptance, requireRouteAcceptance } from "./route-acceptance.ts";
import { requireOwnedRouteFile } from "./route-file-ownership.ts";
import { readOptional, routeReloadSnapshot, servedSnapshotValues } from "./route-reload-snapshot.ts";
import {
  acknowledge,
  invalidateAcknowledgement,
  isAcknowledged,
  routeReloadDigest,
} from "./route-reload-state.ts";
import { DEFAULT_AUTHORITY_PORTS, authoritiesFor, renderTraefikDynamicConfig } from "./routing.ts";
import { httpsHostnames, normalizeDefaultDomain, prepareTlsFiles, removeAppCertificates } from "./tls.ts";

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
    const snapshot = {
      ...(yield* routeReloadSnapshot(dependencies, owner, domain)),
      issuer:
        root === undefined
          ? undefined
          : yield* readOptional(dependencies, defaultIssuerFile(dependencies.paths, domain)),
    };
    const persistedConfig = snapshot.routeConfig;
    const tls =
      root === undefined
        ? undefined
        : yield* prepareTlsFiles(dependencies, {
            owner,
            defaultDomain: domain,
            hostnames,
            snapshot,
            root,
          });
    const expectedConfig =
      renderTraefikDynamicConfig(nextRoutes, owner, expectedTls) +
      (tls === undefined ? "" : `# lando-certificate-generation: ${tls.generation}\n`);
    const tlsCurrent = tls === undefined || snapshot.defaultTlsConfig === tls.config.content;
    const unchanged =
      persistedConfig === expectedConfig &&
      (tls === undefined
        ? snapshot.certificate === undefined && snapshot.privateKey === undefined
        : tls.app.pair.source === "reused" && tls.defaults.pair.source === "reused") &&
      tlsCurrent &&
      snapshot.dashboardConfig === renderTraefikDashboardConfig(domain);
    const warmAcknowledged =
      dependencies.paths.platform === "win32" &&
      unchanged &&
      (yield* isAcknowledged(
        dependencies.stateStore,
        appKey,
        routeReloadDigest(servedSnapshotValues(snapshot)),
      ));
    yield* Effect.gen(function* () {
      pendingReload.add(appKey);
      if (windowsStore !== undefined && !warmAcknowledged)
        yield* invalidateAcknowledgement(windowsStore, appKey);
      if (!unchanged || (tls !== undefined && snapshot.issuer !== tls.issuer.content))
        yield* publishRoutes(dependencies, { owner, domain, snapshot, config: expectedConfig, tls });
    }).pipe(Effect.uninterruptible);
    if (dependencies.paths.platform === "win32" && !warmAcknowledged) {
      const before = routeReloadDigest(
        servedSnapshotValues(yield* routeReloadSnapshot(dependencies, owner, domain)),
      );
      yield* restart;
      if (
        routeReloadDigest(servedSnapshotValues(yield* routeReloadSnapshot(dependencies, owner, domain))) !==
        before
      ) {
        return yield* Effect.fail(acceptanceError(app, "generation-changed"));
      }
      yield* awaitRouteAcceptance(dependencies, owner, {
        routes: nextRoutes,
        ...(tls === undefined ? {} : { servedTls: { domain, tls } }),
      });
      if (
        routeReloadDigest(servedSnapshotValues(yield* routeReloadSnapshot(dependencies, owner, domain))) !==
        before
      ) {
        return yield* Effect.fail(acceptanceError(app, "generation-changed"));
      }
      if (windowsStore !== undefined) yield* acknowledge(windowsStore, appKey, before);
    } else {
      yield* awaitRouteAcceptance(dependencies, owner, {
        routes: nextRoutes,
        ...(tls === undefined ? {} : { servedTls: { domain, tls } }),
      });
      if (
        warmAcknowledged &&
        routeReloadDigest(servedSnapshotValues(yield* routeReloadSnapshot(dependencies, owner, domain))) !==
          routeReloadDigest(servedSnapshotValues(snapshot))
      ) {
        return yield* Effect.fail(acceptanceError(app, "generation-changed"));
      }
    }
    pendingReload.delete(appKey);
    routes.set(appKey, nextRoutes);
    return { app, appliedRoutes: nextRoutes, authorities: authoritiesFor(nextRoutes, ports) };
  });
