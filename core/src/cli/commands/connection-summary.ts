import { type PatternRouteAddress, connectionAuthority } from "@lando/engine/operations/connection-url";
import { activeHostHttpUrls, isAddressedRoute } from "@lando/engine/operations/service-connections";
import type { SummaryField } from "@lando/renderer/summary";
import type { ServiceConnection, ServiceRoute, StartedService } from "@lando/sdk/schema";

type ServiceAddresses = Pick<StartedService, "connections" | "routes">;

export const ROUTE_PATTERN_OPEN_NOTE =
  "Open a hostname a route pattern matches with `lando open <hostname>`.";

export const patternRouteText = (
  address: PatternRouteAddress,
  state: ServiceConnection["state"] = "active",
): string =>
  `${connectionAuthority(address)} [${address.protocol} pattern${state === "active" ? "" : `; ${state}`}]`;

export const connectionText = (connection: ServiceConnection): string => {
  switch (connection.binding) {
    case "assigned": {
      const addresses = [connection.url, ...connection.alternateUrls].join(", ");
      return connection.state === "active" ? addresses : `${addresses} [${connection.state}]`;
    }
    case "pending": {
      return `${connection.host} → ${connection.endpoint.port}/${connection.endpoint.transport} [pending · not published; ${connection.state}]`;
    }
    default: {
      const unreachable: never = connection;
      return unreachable;
    }
  }
};

export const routeText = (route: ServiceRoute): string => {
  switch (route.binding) {
    case "assigned":
      return route.hostMatch === "exact"
        ? `${route.url}${route.state === "active" ? "" : ` [${route.state}]`}`
        : patternRouteText(route, route.state);
    case "pending":
      return `${route.host}${route.pathPrefix} → ${route.endpoint.port}/${route.endpoint.transport} [${route.protocol}${route.hostMatch === "pattern" ? " pattern" : ""}; pending · not published; ${route.state}]`;
    default: {
      const unreachable: never = route;
      return unreachable;
    }
  }
};

export const hostAddressText = (service: ServiceAddresses): string =>
  [
    ...service.connections.filter((row) => row.scope === "host").map(connectionText),
    ...service.routes.filter((row) => row.hostMatch === "exact").map(routeText),
  ].join(", ");

export const routePatternText = (service: ServiceAddresses): string =>
  service.routes
    .filter((row) => row.hostMatch === "pattern")
    .map(routeText)
    .join(", ");

export const appNetworkText = (service: ServiceAddresses): string =>
  service.connections
    .filter((row) => row.scope === "app")
    .map(connectionText)
    .join(", ");

export const hostAddressValue = (service: ServiceAddresses): string =>
  hostAddressText(service) || (service.routes.length > 0 ? "-" : "not published");

export const plainRoutePatternRows = (service: ServiceAddresses & { readonly service: string }): string[] =>
  service.routes.flatMap((route) =>
    route.hostMatch === "pattern" ? [`${service.service}\troute-pattern\t${routeText(route)}`] : [],
  );

export const addressFields = (service: ServiceAddresses): readonly SummaryField[] => {
  const patterns = routePatternText(service);
  return [
    { label: "Host", value: hostAddressValue(service) },
    ...(patterns === "" ? [] : [{ label: "Route patterns", value: patterns }]),
    { label: "App Network", value: appNetworkText(service) || "-" },
  ];
};

/** Text linking must not also decorate an identical inactive or app-network URI. */
export const unambiguousHostHttpUrls = (services: readonly ServiceAddresses[]): readonly string[] => {
  const excluded = new Set(
    services.flatMap((service) => [
      ...service.connections.flatMap((connection) =>
        connection.binding === "assigned" && (connection.scope === "app" || connection.state !== "active")
          ? [connection.url, ...connection.alternateUrls]
          : [],
      ),
      ...service.routes.flatMap((route) =>
        isAddressedRoute(route) && route.state !== "active" ? [route.url] : [],
      ),
    ]),
  );
  return [...new Set(services.flatMap(activeHostHttpUrls))].filter((url) => !excluded.has(url));
};
