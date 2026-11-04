import type { AppId, RoutePlan } from "@lando/sdk/schema";

/** Shared authored provider config; Traefik omits false redirect permanence. */
export const routeMiddlewareConfig = (filter: NonNullable<RoutePlan["filters"]>[number]) => {
  switch (filter.type) {
    case "stripPrefix":
      return { stripPrefix: { prefixes: [filter.prefix] } };
    case "addPrefix":
      return { addPrefix: { prefix: filter.prefix } };
    case "requestHeader":
      return { headers: { customRequestHeaders: { [filter.header]: filter.value } } };
    case "responseHeader":
      return { headers: { customResponseHeaders: { [filter.header]: filter.value } } };
    case "redirect":
      return {
        redirectRegex: {
          regex: "^.*$",
          replacement: filter.to,
          ...(filter.permanent === undefined ? {} : { permanent: filter.permanent }),
        },
      };
    default:
      throw new TypeError(`Unsupported route filter: ${filter satisfies never}`);
  }
};

export const routeBackendUrl = (route: RoutePlan, app: AppId): string => {
  const host = route.backend.host ?? `${String(route.backend.service)}.${String(app)}.internal`;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${route.backend.protocol}://${authority}:${route.backend.port}`;
};
