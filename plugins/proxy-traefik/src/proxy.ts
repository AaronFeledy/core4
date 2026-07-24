import { posix, win32 } from "node:path";

import { Effect, Layer } from "effect";

import { ProxyApplyError, ProxyError, ProxySetupError } from "@lando/sdk/errors";
import { AppId, type ProxyApplyResult, type ProxyAuthority, type RoutePlan } from "@lando/sdk/schema";
import {
  FileSystem,
  GlobalAppService,
  PathsService,
  ProxyService,
  type ProxyServiceShape,
} from "@lando/sdk/services";

import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";

const TRAEFIK_PROXY_ID = "traefik";
const TRAEFIK_DYNAMIC_CONFIG_SOURCE = "./proxy-traefik/dynamic";

interface ProxyFileSystem {
  readonly mkdir: (path: string) => Effect.Effect<void, unknown>;
  readonly writeAtomic: (path: string, content: string | Uint8Array) => Effect.Effect<void, unknown>;
  readonly remove: (path: string) => Effect.Effect<void, unknown>;
}

interface ProxyPaths {
  readonly platform: "darwin" | "linux" | "win32" | "wsl";
  readonly globalAppRoot: string;
}

interface ProxyGlobalApp {
  readonly ensureRunning: (services: ReadonlyArray<string>) => Effect.Effect<void, unknown>;
}

interface TraefikProxyDependencies {
  readonly fileSystem: ProxyFileSystem;
  readonly paths: ProxyPaths;
  readonly globalApp: ProxyGlobalApp;
}

const joinFor = (paths: ProxyPaths) => (paths.platform === "win32" ? win32.join : posix.join);

const dynamicConfigDir = (paths: ProxyPaths): string =>
  joinFor(paths)(paths.globalAppRoot, "proxy-traefik", "dynamic");

const routeFile = (paths: ProxyPaths, app: AppId): string =>
  joinFor(paths)(dynamicConfigDir(paths), `routes-${encodeURIComponent(String(app))}.yml`);

const routeRule = (route: RoutePlan): string => {
  const host = `Host(\`${route.hostname}\`)`;
  return route.pathPrefix === undefined ? host : `${host} && PathPrefix(\`${route.pathPrefix}\`)`;
};

const routeSchemes = (route: RoutePlan): ReadonlyArray<"http" | "https"> =>
  route.scheme === "both" ? ["http", "https"] : [route.scheme];

const authoritiesFor = (routes: ReadonlyArray<RoutePlan>): ReadonlyArray<ProxyAuthority> =>
  routes.flatMap((route) =>
    routeSchemes(route).map((scheme) => ({
      scheme,
      hostname: route.hostname,
      port: scheme === "https" ? TRAEFIK_HTTPS_PORT : TRAEFIK_HTTP_PORT,
    })),
  );

export const renderTraefikDynamicConfig = (routes: ReadonlyArray<RoutePlan>, app: AppId): string => {
  const namespace = encodeURIComponent(String(app));
  const routers = routes.flatMap((route, index) =>
    routeSchemes(route).flatMap((scheme) => [
      `    route-${namespace}-${index}-${scheme}:`,
      `      rule: ${JSON.stringify(routeRule(route))}`,
      `      entryPoints: [${scheme === "https" ? "websecure" : "web"}]`,
      `      service: route-${namespace}-${index}`,
      ...(scheme === "https" ? ["      tls: {}"] : []),
    ]),
  );
  const services = routes.flatMap((route, index) => [
    `    route-${namespace}-${index}:`,
    "      loadBalancer:",
    "        servers:",
    `          - url: ${route.backend.protocol}://${String(route.backend.service)}.${String(app)}.internal:${route.backend.port}`,
  ]);
  return ["http:", "  routers:", ...routers, "  services:", ...services, ""].join("\n");
};

const setupError = (cause: unknown): ProxySetupError =>
  new ProxySetupError({
    message: "Traefik ingress setup failed.",
    proxyId: TRAEFIK_PROXY_ID,
    remediation: "Run `lando meta:global:start traefik` and resolve the reported global-app failure.",
    cause,
  });

const applyError = (app: AppId, cause: unknown): ProxyApplyError =>
  new ProxyApplyError({
    message: `Traefik route application failed for ${String(app)}.`,
    proxyId: TRAEFIK_PROXY_ID,
    app: String(app),
    remediation: "Check the global app route-config directory permissions and retry.",
    cause,
  });

const proxyError = (operation: string, cause: unknown): ProxyError =>
  new ProxyError({
    message: `Traefik proxy ${operation} failed.`,
    proxyId: TRAEFIK_PROXY_ID,
    remediation: "Check the global Traefik service and its route-config directory, then retry.",
    cause,
  });

export const makeTraefikProxyService = (
  dependencies: TraefikProxyDependencies,
): ProxyServiceShape & {
  readonly readAppliedRoutes: (app: AppId) => Effect.Effect<ReadonlyArray<RoutePlan>>;
} => {
  const routes = new Map<string, ReadonlyArray<RoutePlan>>();
  let running = false;

  return {
    id: TRAEFIK_PROXY_ID,
    capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
    setup: () =>
      Effect.gen(function* () {
        yield* dependencies.fileSystem.mkdir(dynamicConfigDir(dependencies.paths));
        yield* dependencies.globalApp.ensureRunning([TRAEFIK_PROXY_ID]);
        running = true;
      }).pipe(Effect.mapError(setupError)),
    applyRoutes: (nextRoutes, app) =>
      Effect.gen(function* () {
        if (nextRoutes.length === 0) {
          yield* dependencies.fileSystem.remove(routeFile(dependencies.paths, app));
          routes.delete(String(app));
        } else {
          yield* dependencies.fileSystem.writeAtomic(
            routeFile(dependencies.paths, app),
            renderTraefikDynamicConfig(nextRoutes, app),
          );
          routes.set(String(app), nextRoutes);
        }
        return {
          app,
          appliedRoutes: nextRoutes,
          authorities: authoritiesFor(nextRoutes),
        } satisfies ProxyApplyResult;
      }).pipe(Effect.mapError((cause) => applyError(app, cause))),
    removeRoutes: (app) =>
      dependencies.fileSystem.remove(routeFile(dependencies.paths, app)).pipe(
        Effect.tap(() => Effect.sync(() => void routes.delete(String(app)))),
        Effect.mapError((cause) => proxyError("route removal", cause)),
      ),
    status: Effect.sync(() => ({
      state: running ? ("running" as const) : ("stopped" as const),
      authorities: [...routes.values()].flatMap(authoritiesFor),
      configuredApps: [...routes.keys()].map((app) => AppId.make(app)),
    })),
    stop: Effect.sync(() => {
      running = false;
    }),
    readAppliedRoutes: (app) => Effect.succeed(routes.get(String(app)) ?? []),
  };
};

export const proxy = Layer.effect(
  ProxyService,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const paths = yield* PathsService;
    const globalApp = yield* GlobalAppService;
    return makeTraefikProxyService({ fileSystem, paths, globalApp });
  }),
);

export { TRAEFIK_DYNAMIC_CONFIG_SOURCE };
