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
  readonly exists: (path: string) => Effect.Effect<boolean, unknown>;
  readonly readDir: (path: string) => Effect.Effect<ReadonlyArray<string>, unknown>;
  readonly readText: (path: string) => Effect.Effect<string, unknown>;
  readonly writeAtomic: (path: string, content: string | Uint8Array) => Effect.Effect<void, unknown>;
  readonly remove: (path: string) => Effect.Effect<void, unknown>;
}

interface ProxyPaths {
  readonly platform: "darwin" | "linux" | "win32" | "wsl";
  readonly globalAppRoot: string;
}

interface ProxyGlobalApp {
  readonly ensureRunning: (services: ReadonlyArray<string>) => Effect.Effect<
    ReadonlyArray<{
      readonly name: string;
      readonly state: string;
      readonly endpoints: ReadonlyArray<string>;
    }>,
    unknown
  >;
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

const routingStateFile = (paths: ProxyPaths): string =>
  joinFor(paths)(dynamicConfigDir(paths), ".lando-routing-state");

const routeRule = (route: RoutePlan): string => {
  const host = `Host(\`${route.hostname}\`)`;
  return route.pathPrefix === undefined ? host : `${host} && PathPrefix(\`${route.pathPrefix}\`)`;
};

const routeSchemes = (route: RoutePlan): ReadonlyArray<"http" | "https"> =>
  route.scheme === "both" ? ["http", "https"] : [route.scheme];

interface AuthorityPorts {
  readonly http: number;
  readonly https: number;
}

const DEFAULT_AUTHORITY_PORTS: AuthorityPorts = {
  http: TRAEFIK_HTTP_PORT,
  https: TRAEFIK_HTTPS_PORT,
};

const authorityPortsFrom = (endpoints: ReadonlyArray<string>): AuthorityPorts => {
  const ports = { ...DEFAULT_AUTHORITY_PORTS };
  for (const endpoint of endpoints) {
    if (!URL.canParse(endpoint)) continue;
    const parsed = new URL(endpoint);
    const port = Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) continue;
    if (parsed.protocol === "http:") ports.http = port;
    if (parsed.protocol === "https:") ports.https = port;
  }
  return ports;
};

const authoritiesFor = (
  routes: ReadonlyArray<RoutePlan>,
  ports: AuthorityPorts,
): ReadonlyArray<ProxyAuthority> =>
  routes.flatMap((route) =>
    routeSchemes(route).map((scheme) => ({
      scheme,
      hostname: route.hostname,
      port: ports[scheme],
    })),
  );

const ROUTE_FILE_PREFIX = "routes-";
const ROUTE_FILE_SUFFIX = ".yml";

const persistedAuthorities = (content: string, ports: AuthorityPorts): ReadonlyArray<ProxyAuthority> => {
  const lines = content.split("\n");
  return lines.flatMap((line, index) => {
    const hostname = line.match(/Host\(`([^`]+)`\)/)?.[1];
    if (hostname === undefined) return [];
    const entryPoint = lines
      .slice(index + 1, index + 5)
      .find((candidate) => candidate.includes("entryPoints:"));
    const scheme = entryPoint?.includes("websecure") === true ? "https" : "http";
    return [{ scheme, hostname, port: ports[scheme] }];
  });
};

const isConcurrentRemoval = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "FileNotFoundError";

const persistedStatus = (dependencies: TraefikProxyDependencies) =>
  Effect.gen(function* () {
    const directory = dynamicConfigDir(dependencies.paths);
    const statePath = routingStateFile(dependencies.paths);
    if (!(yield* dependencies.fileSystem.exists(directory))) {
      return { state: "stopped" as const, authorities: [], configuredApps: [] };
    }

    const running = yield* dependencies.fileSystem.exists(statePath);
    const ports = running
      ? authorityPortsFrom((yield* dependencies.fileSystem.readText(statePath)).split("\n"))
      : DEFAULT_AUTHORITY_PORTS;
    const routeFiles = (yield* dependencies.fileSystem.readDir(directory)).filter(
      (file) => file.startsWith(ROUTE_FILE_PREFIX) && file.endsWith(ROUTE_FILE_SUFFIX),
    );
    const entries = yield* Effect.forEach(routeFiles, (file) =>
      dependencies.fileSystem.readText(joinFor(dependencies.paths)(directory, file)).pipe(
        Effect.map((content) => ({
          app: AppId.make(
            decodeURIComponent(file.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length)),
          ),
          authorities: persistedAuthorities(content, ports),
        })),
        Effect.catchAll((cause) =>
          isConcurrentRemoval(cause) ? Effect.succeed(undefined) : Effect.fail(cause),
        ),
      ),
    );
    const presentEntries = entries.filter((entry) => entry !== undefined);
    return {
      state: running ? ("running" as const) : ("stopped" as const),
      authorities: presentEntries.flatMap((entry) => entry.authorities),
      configuredApps: presentEntries.map((entry) => entry.app),
    };
  });

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
  let authorityPorts = DEFAULT_AUTHORITY_PORTS;

  return {
    id: TRAEFIK_PROXY_ID,
    capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
    setup: () =>
      Effect.gen(function* () {
        yield* dependencies.fileSystem.mkdir(dynamicConfigDir(dependencies.paths));
        const services = yield* dependencies.globalApp.ensureRunning([TRAEFIK_PROXY_ID]);
        const endpoints = services.find((service) => service.name === TRAEFIK_PROXY_ID)?.endpoints ?? [];
        authorityPorts = authorityPortsFrom(endpoints);
        yield* dependencies.fileSystem.writeAtomic(
          routingStateFile(dependencies.paths),
          endpoints.join("\n"),
        );
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
          authorities: authoritiesFor(nextRoutes, authorityPorts),
        } satisfies ProxyApplyResult;
      }).pipe(Effect.mapError((cause) => applyError(app, cause))),
    removeRoutes: (app) =>
      dependencies.fileSystem.remove(routeFile(dependencies.paths, app)).pipe(
        Effect.tap(() => Effect.sync(() => void routes.delete(String(app)))),
        Effect.mapError((cause) => proxyError("route removal", cause)),
      ),
    status: persistedStatus(dependencies).pipe(Effect.mapError((cause) => proxyError("status", cause))),
    stop: Effect.gen(function* () {
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
      routes.clear();
    }).pipe(Effect.mapError((cause) => proxyError("stop", cause))),
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
