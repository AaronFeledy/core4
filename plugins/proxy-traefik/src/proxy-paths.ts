import { posix, win32 } from "node:path";

import { AppId } from "@lando/sdk/schema";

import type { ProxyPaths } from "./proxy-types.ts";

export const ROUTE_FILE_PREFIX = "routes-";
export const ROUTE_FILE_SUFFIX = ".yml";
export const TRAEFIK_CONTAINER_CERTIFICATE_DIR = "/etc/traefik/dynamic/certs";

export const joinFor = (paths: ProxyPaths) => (paths.platform === "win32" ? win32.join : posix.join);

export const dynamicConfigDir = (paths: ProxyPaths): string =>
  joinFor(paths)(paths.globalAppRoot, "proxy-traefik", "dynamic");

export const diagnosticDir = (paths: ProxyPaths): string =>
  joinFor(paths)(paths.globalAppRoot, "proxy-traefik", "diagnostic");

export const diagnosticConfigFile = (paths: ProxyPaths): string =>
  joinFor(paths)(diagnosticDir(paths), "nginx.conf");

// Lives beside the watched directory, never inside it: the watched directory is exactly what is broken when this record is written.
export const watcherDiagnosticFile = (paths: ProxyPaths): string =>
  joinFor(paths)(paths.globalAppRoot, "proxy-traefik", "watcher-diagnostic.json");

export const diagnosticHtmlFile = (paths: ProxyPaths): string =>
  joinFor(paths)(diagnosticDir(paths), "404.html");

export const fallbackConfigFile = (paths: ProxyPaths): string =>
  joinFor(paths)(dynamicConfigDir(paths), "fallback.yml");

export const dashboardConfigFile = (paths: ProxyPaths): string =>
  joinFor(paths)(dynamicConfigDir(paths), "dashboard.yml");

export const routeFile = (paths: ProxyPaths, app: AppId): string =>
  joinFor(paths)(dynamicConfigDir(paths), routeFileName(app));

export const routeFileName = (app: AppId): string =>
  `${ROUTE_FILE_PREFIX}${encodeURIComponent(String(app))}${ROUTE_FILE_SUFFIX}`;

export const isRouteFileName = (name: string): boolean => {
  if (!name.startsWith(ROUTE_FILE_PREFIX) || !name.endsWith(ROUTE_FILE_SUFFIX)) return false;
  return name.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length).length > 0;
};

export const routeFileAppId = (name: string): AppId | undefined => {
  if (!isRouteFileName(name)) return undefined;
  try {
    return AppId.make(decodeURIComponent(name.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length)));
  } catch {
    return undefined;
  }
};

export const routingStateFile = (paths: ProxyPaths): string =>
  joinFor(paths)(dynamicConfigDir(paths), ".lando-routing-state");

export const acquisitionStateFile = (paths: ProxyPaths): string =>
  joinFor(paths)(dynamicConfigDir(paths), ".lando-port-acquisition.json");

export const defaultDomainFile = (paths: ProxyPaths): string =>
  joinFor(paths)(dynamicConfigDir(paths), ".lando-default-domain");

export const defaultTlsFile = (paths: ProxyPaths): string =>
  joinFor(paths)(dynamicConfigDir(paths), "tls-default.yml");

export const certificateDir = (paths: ProxyPaths): string => joinFor(paths)(dynamicConfigDir(paths), "certs");

export const defaultCertificateNames = (defaultDomain: string) => {
  const encoded = encodeURIComponent(defaultDomain);
  return {
    cert: `default-${encoded}.crt`,
    key: `default-${encoded}.key`,
  };
};

export const defaultCertificateFiles = (paths: ProxyPaths, defaultDomain: string) => {
  const names = defaultCertificateNames(defaultDomain);
  return {
    cert: joinFor(paths)(certificateDir(paths), names.cert),
    key: joinFor(paths)(certificateDir(paths), names.key),
  };
};

export const appCertificateFiles = (paths: ProxyPaths, app: AppId) => {
  const encodedApp = encodeURIComponent(String(app));
  return {
    cert: joinFor(paths)(certificateDir(paths), `${encodedApp}.crt`),
    key: joinFor(paths)(certificateDir(paths), `${encodedApp}.key`),
  };
};
