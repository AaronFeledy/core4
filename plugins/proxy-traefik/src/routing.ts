import type { AppId, ProxyAuthority, RoutePlan } from "@lando/sdk/schema";

import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";

const routeRule = (route: RoutePlan): string => {
  const host = `Host(\`${route.hostname}\`)`;
  return route.pathPrefix === undefined ? host : `${host} && PathPrefix(\`${route.pathPrefix}\`)`;
};

export const routeSchemes = (route: RoutePlan): ReadonlyArray<"http" | "https"> =>
  route.scheme === "both" ? ["http", "https"] : [route.scheme];

export interface AuthorityPorts {
  readonly http: number;
  readonly https: number;
}

export const DEFAULT_AUTHORITY_PORTS: AuthorityPorts = {
  http: TRAEFIK_HTTP_PORT,
  https: TRAEFIK_HTTPS_PORT,
};

export const authorityPortsFrom = (endpoints: ReadonlyArray<string>): AuthorityPorts => {
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

export const authoritiesFor = (
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

export const persistedAuthorities = (
  content: string,
  ports: AuthorityPorts,
): ReadonlyArray<ProxyAuthority> => {
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

export interface TraefikTlsFiles {
  readonly certFile: string;
  readonly keyFile: string;
}

export const renderTraefikDynamicConfig = (
  routes: ReadonlyArray<RoutePlan>,
  app: AppId,
  tlsFiles?: TraefikTlsFiles,
): string => {
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
    `          - url: ${route.backend.protocol}://${route.backend.host ?? `${String(route.backend.service)}.${String(app)}.internal`}:${route.backend.port}`,
  ]);
  const tls =
    tlsFiles === undefined
      ? []
      : [
          "tls:",
          "  certificates:",
          `    - certFile: ${tlsFiles.certFile}`,
          `      keyFile: ${tlsFiles.keyFile}`,
        ];
  return ["http:", "  routers:", ...routers, "  services:", ...services, ...tls, ""].join("\n");
};

export const renderTraefikDefaultTlsConfig = (files: TraefikTlsFiles): string =>
  [
    "tls:",
    "  stores:",
    "    default:",
    "      defaultCertificate:",
    `        certFile: ${files.certFile}`,
    `        keyFile: ${files.keyFile}`,
    "",
  ].join("\n");
