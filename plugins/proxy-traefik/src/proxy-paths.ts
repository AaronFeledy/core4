import { posix, win32 } from "node:path";

import type { AppId } from "@lando/sdk/schema";

import type { ProxyPaths } from "./proxy-types.ts";

export const ROUTE_FILE_PREFIX = "routes-";
export const ROUTE_FILE_SUFFIX = ".yml";
export const TRAEFIK_CONTAINER_CERTIFICATE_DIR = "/etc/traefik/dynamic/certs";

export const joinFor = (paths: ProxyPaths) => (paths.platform === "win32" ? win32.join : posix.join);

export const dynamicConfigDir = (paths: ProxyPaths): string =>
  joinFor(paths)(paths.globalAppRoot, "proxy-traefik", "dynamic");

export const routeFile = (paths: ProxyPaths, app: AppId): string =>
  joinFor(paths)(
    dynamicConfigDir(paths),
    `${ROUTE_FILE_PREFIX}${encodeURIComponent(String(app))}${ROUTE_FILE_SUFFIX}`,
  );

export const routingStateFile = (paths: ProxyPaths): string =>
  joinFor(paths)(dynamicConfigDir(paths), ".lando-routing-state");

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
  return encodedAppCertificateFiles(paths, encodeURIComponent(String(app)));
};

export const encodedAppCertificateFiles = (paths: ProxyPaths, encodedApp: string) => {
  return {
    cert: joinFor(paths)(certificateDir(paths), `${encodedApp}.crt`),
    key: joinFor(paths)(certificateDir(paths), `${encodedApp}.key`),
  };
};
