import { Result } from "effect";
import { isPlainRecord } from "./record.ts";

const maskTemplateSpans = (text: string): string =>
  text.replace(/\{\{[\s\S]*?\}\}|\$\{[^}]*\}/g, (span) => "a".repeat(span.length));

const parseLayerShorthand = (text: string) => {
  const masked = maskTemplateSpans(text);
  const parsed = parseRouteShorthand(masked);
  if (Result.isFailure(parsed)) return undefined;
  if (masked === text) return parsed.success;
  const hostnameEnd = parsed.success.hostname.length;
  const slash = masked.indexOf("/");
  return {
    hostname: text.slice(0, hostnameEnd),
    ...(parsed.success.endpoint === undefined
      ? {}
      : { endpoint: Number(text.slice(hostnameEnd + 1, slash < 0 ? text.length : slash)) }),
    ...(slash < 0 ? {} : { pathPrefix: text.slice(slash) }),
  };
};

/** Parse authored hostname[:port][/path] without injecting defaults into a layer. */
export const parseRouteShorthand = (text: string) => {
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
  if (
    portText !== undefined &&
    (!/^[0-9]+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
  ) {
    return Result.fail("Use a numeric port from 1 through 65535, followed by / if a path is present.");
  }
  return Result.succeed({
    hostname,
    ...(portText === undefined ? {} : { endpoint: Number(portText) }),
    ...(pathPrefix === undefined ? {} : { pathPrefix }),
  });
};

/** Build the atomic identity shared by layered merging and planner conflicts. */
export const routeMatchKey = (route: {
  readonly scheme?: "http" | "https";
  readonly hostname: string;
  readonly pathPrefix?: string;
}): string =>
  JSON.stringify([
    route.scheme ?? "https",
    maskTemplateSpans(route.hostname) === route.hostname ? route.hostname.toLowerCase() : route.hostname,
    route.pathPrefix ?? "/",
  ]);

/** Promote a shorthand only when matching requires a sparse mapping. */
export const routeInputObject = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "string") return isPlainRecord(value) ? value : undefined;
  return parseLayerShorthand(value);
};

/** Expand both into independent scheme entries; leave other authored spellings intact. */
export const expandRouteSchemes = (value: unknown): ReadonlyArray<unknown> =>
  isPlainRecord(value) && value.scheme === "both"
    ? [
        { ...value, scheme: "http" },
        { ...value, scheme: "https" },
      ]
    : [value];

/** Resolve an authored atomic identity using literal template text; invalid routes are unkeyed. */
export const routeInputKey = (value: unknown): string | undefined => {
  const route = routeInputObject(value);
  if (route === undefined || typeof route.hostname !== "string") return undefined;
  const hostname = parseLayerShorthand(route.hostname);
  if (hostname === undefined || hostname.hostname !== route.hostname) return undefined;
  if (route.scheme !== undefined && route.scheme !== "http" && route.scheme !== "https") return undefined;
  if (
    route.pathPrefix !== undefined &&
    (typeof route.pathPrefix !== "string" ||
      (!route.pathPrefix.startsWith("/") && maskTemplateSpans(route.pathPrefix) === route.pathPrefix))
  )
    return undefined;
  return routeMatchKey({
    hostname: route.hostname,
    ...(route.scheme === undefined ? {} : { scheme: route.scheme }),
    ...(typeof route.pathPrefix === "string" ? { pathPrefix: route.pathPrefix } : {}),
  });
};
