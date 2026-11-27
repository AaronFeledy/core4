import {
  PortNumber,
  type ServiceConnection,
  type ServiceRoute,
  type StartedService,
} from "@lando/sdk/schema";

type AssignedRoute = Extract<ServiceRoute, { binding: "assigned" }>;
type RouteRowInput = Pick<AssignedRoute, "host" | "protocol" | "port" | "pathPrefix"> &
  ({ readonly hostMatch: "exact"; readonly url: string } | { readonly hostMatch: "pattern" });

export const routeRow = (
  address: RouteRowInput,
  state: AssignedRoute["state"] = "active",
  endpoint: AssignedRoute["endpoint"] = { port: 80, transport: "tcp", names: [], primary: false },
): AssignedRoute => {
  return { ...address, binding: "assigned", state, endpoint };
};

export const service = (
  connections: readonly ServiceConnection[],
  routes: readonly ServiceRoute[] = [],
): Pick<StartedService, "connections" | "routes"> => ({ connections, routes });

export const connections = (
  urls: readonly string[],
  scope: ServiceConnection["scope"] = "host",
  state: ServiceConnection["state"] = "active",
): readonly ServiceConnection[] =>
  urls.map((url) => {
    const parsed = new URL(url);
    const protocol =
      parsed.protocol === "https:"
        ? "https"
        : parsed.protocol === "http:"
          ? "http"
          : parsed.protocol === "udp:"
            ? "udp"
            : "tcp";
    const port = PortNumber.make(Number(parsed.port || (protocol === "https" ? 443 : 80)));
    const address = {
      binding: "assigned" as const,
      host: parsed.hostname,
      port,
      url,
      alternateUrls: [],
      state,
      protocol,
      endpoint: {
        port,
        transport: protocol === "udp" ? ("udp" as const) : ("tcp" as const),
        names: [],
        primary: true,
      },
    } as const;
    return scope === "app"
      ? { ...address, scope, source: "listener" }
      : { ...address, scope, source: "publication" };
  });
