import { RouteInputError } from "@lando/sdk/errors";
import { parseRouteShorthand } from "@lando/sdk/landofile";
import type { RouteFilter, RouteInput } from "@lando/sdk/schema";
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

export const normalizeRoute = (
  route: RouteInput,
  ctx: { readonly keyPath: string; readonly file?: string },
): Result.Result<NormalizedRoute, RouteInputError> => {
  const source = { key: ctx.keyPath, ...(ctx.file === undefined ? {} : { file: ctx.file }) };
  if (typeof route !== "string")
    return Result.succeed({
      hostname: route.hostname,
      source,
      ...(route.scheme === undefined ? {} : { scheme: route.scheme }),
      ...(route.endpoint === undefined ? {} : { endpoint: route.endpoint }),
      ...(route.pathPrefix === undefined ? {} : { pathPrefix: route.pathPrefix }),
      filters: route.filters ?? [],
    });
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

export const normalizeRoutes = (
  routes: ReadonlyArray<RouteInput>,
  ctx: { readonly keyPath: string; readonly file?: string },
): Result.Result<ReadonlyArray<NormalizedRoute>, RouteInputError> =>
  Result.all(
    routes.map((route, index) => normalizeRoute(route, { ...ctx, keyPath: `${ctx.keyPath}[${index}]` })),
  );
