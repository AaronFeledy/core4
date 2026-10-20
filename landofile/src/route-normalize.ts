import { RouteInputError } from "@lando/sdk/errors";
import { parseRouteHostname, parseRoutePathPrefix, parseRouteShorthand } from "@lando/sdk/landofile";
import type { RouteFilter, RouteInput, RouteObjectInput } from "@lando/sdk/schema";
import { Result } from "effect";

export { parseRouteShorthand } from "@lando/sdk/landofile";

export interface NormalizedRoute {
  readonly source?: { readonly key: string; readonly file?: string };
  readonly hostname: string;
  readonly scheme?: "http" | "https" | "both";
  readonly endpoint?: string | number;
  readonly pathPrefix?: string;
  readonly filters: ReadonlyArray<RouteFilter>;
}

type RouteContext = { readonly keyPath: string; readonly file?: string };

const routeSource = (ctx: RouteContext) => ({
  key: ctx.keyPath,
  ...(ctx.file === undefined ? {} : { file: ctx.file }),
});

const objectFieldErrors = (route: RouteObjectInput, ctx: RouteContext): ReadonlyArray<RouteInputError> => {
  const hostname = parseRouteHostname(route.hostname);
  const pathPrefix = route.pathPrefix === undefined ? undefined : parseRoutePathPrefix(route.pathPrefix);
  return [
    ...(Result.isFailure(hostname)
      ? [
          new RouteInputError({
            ...routeSource(ctx),
            key: `${ctx.keyPath}.hostname`,
            message: hostname.failure,
            remediation: `Set ${ctx.keyPath}.hostname to a host pattern such as app.lndo.site; put any port in endpoint and any path in pathPrefix, or write the route as hostname[:port][/pathPrefix] shorthand.`,
          }),
        ]
      : []),
    ...(pathPrefix !== undefined && Result.isFailure(pathPrefix)
      ? [
          new RouteInputError({
            ...routeSource(ctx),
            key: `${ctx.keyPath}.pathPrefix`,
            message: pathPrefix.failure,
            remediation: `Correct ${ctx.keyPath}.pathPrefix to begin with / and contain no whitespace, query string, or fragment.`,
          }),
        ]
      : []),
  ];
};

export const normalizeRoute = (
  route: RouteInput,
  ctx: RouteContext,
): Result.Result<NormalizedRoute, RouteInputError> => {
  const source = routeSource(ctx);
  if (typeof route !== "string") {
    const [error] = objectFieldErrors(route, ctx);
    if (error !== undefined) return Result.fail(error);
    return Result.succeed({
      hostname: route.hostname,
      source,
      ...(route.scheme === undefined ? {} : { scheme: route.scheme }),
      ...(route.endpoint === undefined ? {} : { endpoint: route.endpoint }),
      ...(route.pathPrefix === undefined ? {} : { pathPrefix: route.pathPrefix }),
      filters: route.filters ?? [],
    });
  }
  return Result.mapError(
    Result.map(parseRouteShorthand(route), (normalized) => ({ ...normalized, filters: [], source })),
    (message) =>
      new RouteInputError({
        ...source,
        message,
        remediation: `Correct ${ctx.keyPath} using hostname[:port][/pathPrefix]. ${message}`,
      }),
  );
};

/** Every invalid field of one route; lint reports them all while planning stops at the first. */
export const routeInputErrors = (route: RouteInput, ctx: RouteContext): ReadonlyArray<RouteInputError> =>
  typeof route === "string"
    ? Result.match(normalizeRoute(route, ctx), { onFailure: (error) => [error], onSuccess: () => [] })
    : objectFieldErrors(route, ctx);

export const normalizeRoutes = (
  routes: ReadonlyArray<RouteInput>,
  ctx: RouteContext,
): Result.Result<ReadonlyArray<NormalizedRoute>, RouteInputError> =>
  Result.all(
    routes.map((route, index) => normalizeRoute(route, { ...ctx, keyPath: `${ctx.keyPath}[${index}]` })),
  );
