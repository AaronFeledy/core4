import { isLegacyTagged } from "@lando/sdk/landofile";
import type { RouteFilter, RouteObjectInput } from "@lando/sdk/schema";
import type { Lando3Path } from "./contract.ts";
import { type V4Wire, isPlainObject } from "./lowering-contract.ts";
import { type Report, lowerText } from "./lowering-report.ts";

const HOSTNAME =
  /^[A-Za-z0-9*](?:[A-Za-z0-9*-]*[A-Za-z0-9*])?(?:\.[A-Za-z0-9*](?:[A-Za-z0-9*-]*[A-Za-z0-9*])?)*$/;
const expression = (text: string) => text.includes("{{") || text.includes("${");

const parseRoute = (value: unknown): RouteObjectInput | undefined => {
  if (isLegacyTagged(value)) return undefined;
  const object = isPlainObject(value) ? value : undefined;
  const text = typeof value === "string" ? value : object?.hostname;
  if (typeof text !== "string" || /[\s?#]/.test(text) || text.includes("://") || expression(text))
    return undefined;
  const slash = text.indexOf("/");
  const authority = slash < 0 ? text : text.slice(0, slash);
  const colon = authority.indexOf(":");
  const hostname = colon < 0 ? authority : authority.slice(0, colon);
  if (!HOSTNAME.test(hostname)) return undefined;
  const port = object?.port !== undefined ? object.port : colon < 0 ? undefined : authority.slice(colon + 1);
  if (
    port !== undefined &&
    ((typeof port !== "number" && typeof port !== "string") ||
      (typeof port === "string" && !/^[0-9]+$/.test(port)) ||
      !Number.isInteger(Number(port)) ||
      Number(port) < 1 ||
      Number(port) > 65535)
  )
    return undefined;
  const pathname = object?.pathname !== undefined ? object.pathname : slash < 0 ? "" : text.slice(slash);
  if (typeof pathname !== "string" || expression(pathname) || /[\s?#]/.test(pathname)) return undefined;
  const prefix = `/${pathname.replace(/^\/+|\/+$/g, "")}`;
  return {
    hostname,
    scheme: "both",
    ...(port === undefined ? {} : { endpoint: Number(port) }),
    ...(prefix === "/" ? {} : { pathPrefix: prefix, filters: [{ type: "stripPrefix", prefix }] }),
  };
};

interface Middleware {
  readonly value: unknown;
  readonly path: Lando3Path;
}
interface RouteGroup {
  readonly route: RouteObjectInput;
  readonly middlewares: Map<string | symbol, Middleware>;
}

const lowerMiddleware = ({ value, path }: Middleware, report: Report): RouteFilter | undefined => {
  const entry = isPlainObject(value) && !isLegacyTagged(value) ? value : {};
  const { name, key, value: raw } = entry;
  const match =
    typeof key === "string" ? /^headers\.custom(request|response)headers\.([A-Za-z0-9-]+)$/i.exec(key) : null;
  const header = match?.[2];
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    expression(name) ||
    header === undefined ||
    (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean")
  ) {
    report(
      "dropped",
      path,
      `Route middleware "${typeof name === "string" ? name : "unnamed"}" (${typeof key === "string" ? key : "missing key"}) has no Lando 4 route filter.`,
      "Configure the middleware's behavior manually in a Lando 4 route filter or in the application.",
    );
    return undefined;
  }
  const text = lowerText(String(raw), [...path, "value"], report);
  if (typeof text !== "string") return undefined;
  return {
    type: match?.[1]?.toLowerCase() === "request" ? "requestHeader" : "responseHeader",
    name,
    header,
    value: text,
  };
};

const emitRoutes = (group: RouteGroup, report: Report): readonly RouteObjectInput[] => {
  const plain: RouteFilter[] = [...(group.route.filters ?? [])];
  const secured: RouteFilter[] = [];
  for (const middleware of group.middlewares.values()) {
    const filter = lowerMiddleware(middleware, report);
    if (filter !== undefined) (filter.name?.endsWith("-secured") ? secured : plain).push(filter);
  }
  if (secured.length > 0)
    return [
      { ...group.route, scheme: "http", filters: plain },
      { ...group.route, scheme: "https", filters: [...plain, ...secured] },
    ];
  return [{ ...group.route, ...(plain.length === 0 ? {} : { filters: plain }) }];
};

export const lowerProxy = (value: unknown, report: Report): { readonly fragment: V4Wire } => {
  if (value === undefined) return { fragment: {} };
  const toggle = typeof value === "string" ? value.toLowerCase() : value;
  if (toggle === false || toggle === "off") {
    report(
      "rewritten",
      ["proxy"],
      "Lando 4 keeps services and host ports but skips the shared router.",
      "Review router.enabled: false in the generated Landofile.",
    );
    return { fragment: { router: { enabled: false } } };
  }
  if (toggle === true || toggle === "on") {
    report(
      "dropped",
      ["proxy"],
      "Lando 4 enables the router by default.",
      "No router setting is needed; configure routes under proxy.",
    );
    return { fragment: {} };
  }
  if (!isPlainObject(value) || isLegacyTagged(value)) {
    report(
      "unsupported",
      ["proxy"],
      "proxy must map services to route lists, or be an ON/OFF router switch.",
      "Inline the proxy mapping or choose ON or OFF before converting.",
    );
    return { fragment: {} };
  }
  const proxy = new Map<string, readonly RouteObjectInput[]>();
  for (const [service, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) {
      report(
        "unsupported",
        ["proxy", service],
        "A service's proxy routes must be a list.",
        "Rewrite this service's proxy value as a list of routes.",
      );
      continue;
    }
    const groups: RouteGroup[] = [];
    const objects = new Map<string, RouteGroup>();
    entries.forEach((entry: unknown, index) => {
      const path = ["proxy", service, index];
      const route = parseRoute(entry);
      if (route === undefined) {
        report(
          "unsupported",
          path,
          "This route cannot become a literal hostname, optional port and path prefix.",
          "Use hostname[:port][/path] or an inline route object, a port from 1 through 65535, and no {{ or ${ expressions.",
        );
        return;
      }
      report(
        "rewritten",
        path,
        "The route now explicitly serves HTTP and HTTPS and strips any matched path prefix.",
        "Review the route endpoint, path prefix and filters before starting the app.",
      );
      const identity = JSON.stringify([route.hostname, route.endpoint, route.pathPrefix]);
      const object = isPlainObject(entry) ? entry : undefined;
      const existing = object === undefined ? undefined : objects.get(identity);
      const group = existing ?? { route, middlewares: new Map<string | symbol, Middleware>() };
      if (existing === undefined) groups.push(group);
      if (object === undefined) return;
      objects.set(identity, group);
      if (object.middlewares === undefined) return;
      if (!Array.isArray(object.middlewares)) {
        report(
          "dropped",
          [...path, "middlewares"],
          'Route middleware "unnamed" must be supplied as a list.',
          "Configure the middleware manually as Lando 4 route filters.",
        );
        return;
      }
      object.middlewares.forEach((middleware: unknown, middlewareIndex) => {
        const name = isPlainObject(middleware) && !isLegacyTagged(middleware) ? middleware.name : undefined;
        group.middlewares.set(typeof name === "string" ? name : Symbol(), {
          value: middleware,
          path: [...path, "middlewares", middlewareIndex],
        });
      });
    });
    const routes = groups.flatMap((group) => emitRoutes(group, report));
    if (routes.length > 0) proxy.set(service, routes);
  }
  return { fragment: proxy.size === 0 ? {} : { proxy: Object.fromEntries(proxy) } };
};
