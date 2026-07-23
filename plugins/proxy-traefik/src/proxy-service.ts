import { posix, win32 } from "node:path";

import { type Context, Effect, Layer } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import type { AppId, RoutePlan } from "@lando/sdk/schema";
import { FileSystem, PathsService, ProxyService, type ProxyServiceShape } from "@lando/sdk/services";

export const TRAEFIK_PROXY_ID = "traefik" as const;
export const TRAEFIK_DYNAMIC_CONFIG_SOURCE = "./proxy-traefik/dynamic" as const;

const pathJoin = (paths: Context.Tag.Service<typeof PathsService>) =>
  paths.platform === "win32" ? win32.join : posix.join;

export const traefikDynamicConfigHostDir = (paths: Context.Tag.Service<typeof PathsService>): string =>
  pathJoin(paths)(paths.globalAppRoot, "proxy-traefik", "dynamic");

const routeFilePath = (paths: Context.Tag.Service<typeof PathsService>, appId: AppId): string =>
  pathJoin(paths)(traefikDynamicConfigHostDir(paths), `routes-${encodeURIComponent(String(appId))}.yml`);

const backendPort = (route: RoutePlan): number => (typeof route.endpoint === "number" ? route.endpoint : 80);

const routeRule = (route: RoutePlan): string => {
  const host = `Host(\`${route.hostname}\`)`;
  return route.pathPrefix === undefined ? host : `${host} && PathPrefix(\`${route.pathPrefix}\`)`;
};

const routerLines = (route: RoutePlan, index: number, appId: AppId): ReadonlyArray<string> => {
  const schemes = route.scheme === "both" ? (["http", "https"] as const) : [route.scheme];
  const routeName = `route-${String(appId)}-${index}`;
  return schemes.flatMap((scheme) => [
    `    ${routeName}-${scheme}:`,
    `      rule: ${JSON.stringify(routeRule(route))}`,
    `      entryPoints: [${scheme === "https" ? "websecure" : "web"}]`,
    `      service: ${routeName}`,
    ...(scheme === "https" ? ["      tls: {}"] : []),
  ]);
};

export const renderTraefikDynamicConfig = (routes: ReadonlyArray<RoutePlan>, appId: AppId): string => {
  const routers = routes.flatMap((route, index) => routerLines(route, index, appId));
  const services = routes.flatMap((route, index) => [
    `    route-${String(appId)}-${index}:`,
    "      loadBalancer:",
    "        servers:",
    `          - url: http://${String(route.service)}.${String(appId)}.internal:${backendPort(route)}`,
  ]);
  return ["http:", "  routers:", ...routers, "  services:", ...services, ""].join("\n");
};

const proxyError = (operation: string, cause: unknown): ProxyError =>
  new ProxyError({
    message: `Traefik proxy ${operation} failed.`,
    proxyId: TRAEFIK_PROXY_ID,
    cause,
  });

const makeProxyService = (
  fileSystem: Context.Tag.Service<typeof FileSystem>,
  paths: Context.Tag.Service<typeof PathsService>,
): ProxyServiceShape => {
  const configDir = traefikDynamicConfigHostDir(paths);
  const setup = () =>
    fileSystem.mkdir(configDir).pipe(Effect.mapError((cause) => proxyError("setup", cause)));

  return {
    id: TRAEFIK_PROXY_ID,
    setup,
    applyRoutes: (routes, appId) =>
      Effect.gen(function* () {
        yield* setup();
        const file = routeFilePath(paths, appId);
        if (routes.length === 0) {
          yield* fileSystem.remove(file);
          return;
        }
        yield* fileSystem.writeAtomic(file, renderTraefikDynamicConfig(routes, appId));
      }).pipe(Effect.mapError((cause) => proxyError("route apply", cause))),
    removeRoutes: (appId) =>
      fileSystem
        .remove(routeFilePath(paths, appId))
        .pipe(Effect.mapError((cause) => proxyError("route removal", cause))),
  };
};

export const ProxyServiceTraefikGlobalAppLive = Layer.effect(
  ProxyService,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const paths = yield* PathsService;
    return makeProxyService(fileSystem, paths);
  }),
);
