import { RouteInputError } from "@lando/sdk/errors";
import type { RouteFilter, RouteInput } from "@lando/sdk/schema";
import { Result } from "effect";

export interface NormalizedRoute {
  readonly source?: { readonly key: string; readonly file?: string };
  readonly hostname: string;
  readonly scheme?: "http" | "https" | "both";
  readonly endpoint?: string | number;
  readonly pathPrefix?: string;
  readonly filters: ReadonlyArray<RouteFilter>;
}

export const parseRouteShorthand = (text: string): Result.Result<NormalizedRoute, string> => {
  if (text.length === 0 || /\s/.test(text)) return Result.fail("Use a non-empty route without whitespace.");
  if (text.includes("://")) return Result.fail("Omit the scheme prefix; use an object route to set scheme.");
  if (/[?#]/.test(text)) return Result.fail("Remove query strings and fragments from the route.");
  const slash = text.indexOf("/");
  const authority = slash < 0 ? text : text.slice(0, slash);
  const pathPrefix = slash < 0 ? undefined : text.slice(slash);
  const colon = authority.indexOf(":");
  const hostname = colon < 0 ? authority : authority.slice(0, colon);
  if (
    !/^[A-Za-z0-9*](?:[A-Za-z0-9*-]*[A-Za-z0-9*])?(?:\.[A-Za-z0-9*](?:[A-Za-z0-9*-]*[A-Za-z0-9*])?)*$/.test(
      hostname,
    )
  ) {
    return Result.fail(
      "Use dot-separated hostname labels without leading or trailing hyphens, and begin any path with /.",
    );
  }
  const portText = colon < 0 ? undefined : authority.slice(colon + 1);
  const port = portText === undefined ? undefined : Number(portText);
  if (
    portText !== undefined &&
    (!/^[0-9]+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
  ) {
    return Result.fail("Use a numeric port from 1 through 65535, followed by / if a path is present.");
  }
  return Result.succeed({
    hostname,
    ...(port === undefined ? {} : { endpoint: port }),
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
    filters: [],
  });
};

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
    Result.map(parseRouteShorthand(route), (normalized) => ({
      ...normalized,
      source,
    })),
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
