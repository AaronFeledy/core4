import { parseRouteHostname, parseRoutePathPrefix, parseRouteShorthand } from "@lando/sdk/landofile";
import {
  type RouteFilter,
  type RouteInput,
  type RouteObjectInput,
  type ValidationIssue,
  type ValidationIssuePath,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
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

type RouteContext = { readonly path: ValidationIssuePath; readonly file?: string };

const routeSource = (ctx: RouteContext) => ({
  key: formatValidationIssuePath(ctx.path),
  ...(ctx.file === undefined ? {} : { file: ctx.file }),
});

const objectFieldErrors = (route: RouteObjectInput, ctx: RouteContext): ReadonlyArray<ValidationIssue> => {
  const keyPath = formatValidationIssuePath(ctx.path);
  const hostname = parseRouteHostname(route.hostname);
  const pathPrefix = route.pathPrefix === undefined ? undefined : parseRoutePathPrefix(route.pathPrefix);
  return [
    ...(Result.isFailure(hostname)
      ? [
          {
            path: [...ctx.path, "hostname"],
            message: hostname.failure,
            suggestion: `Set ${keyPath}.hostname to the host pattern only, such as app.lndo.site; put a scheme, port, or path in scheme, endpoint, or pathPrefix, or write the route as hostname[:port][/pathPrefix] shorthand.`,
          },
        ]
      : []),
    ...(pathPrefix !== undefined && Result.isFailure(pathPrefix)
      ? [
          {
            path: [...ctx.path, "pathPrefix"],
            message: pathPrefix.failure,
            suggestion: `Correct ${keyPath}.pathPrefix to begin with / and contain no whitespace, query string, or fragment.`,
          },
        ]
      : []),
  ];
};

export const normalizeRoute = (
  route: RouteInput,
  ctx: RouteContext,
): Result.Result<NormalizedRoute, ReadonlyArray<ValidationIssue>> => {
  const source = routeSource(ctx);
  if (typeof route !== "string") {
    const errors = objectFieldErrors(route, ctx);
    if (errors.length > 0) return Result.fail(errors);
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
    (message) => [
      {
        path: ctx.path,
        message,
        suggestion: `Correct ${source.key} using hostname[:port][/pathPrefix]. ${message}`,
      },
    ],
  );
};
