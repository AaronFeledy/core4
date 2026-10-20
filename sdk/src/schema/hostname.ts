import { Schema } from "effect";

// ============================================================================
// Concrete route hostnames, DNS domains, and request path prefixes
// ============================================================================

export const ROUTE_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9*](?:[A-Za-z0-9*-]{0,61}[A-Za-z0-9*])?(?:\.[A-Za-z0-9*](?:[A-Za-z0-9*-]{0,61}[A-Za-z0-9*])?)*(?![\s\S])/u;
export const DOMAIN_NAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?![\s\S])/u;
export const ROUTE_PATH_PREFIX_PATTERN = /^\/[^\s?#]*(?![\s\S])/u;

export const RouteHostname = Schema.String.check(
  Schema.isPattern(ROUTE_HOSTNAME_PATTERN, {
    message:
      "Expected a host pattern such as app.lndo.site or *.app.lndo.site, without a scheme, port, or path.",
  }),
).annotate({
  identifier: "RouteHostname",
  title: "Route Hostname",
  description:
    "Dot-separated host pattern of letters, digits, hyphens, and * wildcards, without empty labels or leading or trailing hyphens; at most 63 characters per label and 253 overall.",
});
export type RouteHostname = typeof RouteHostname.Type;

export const DomainName = Schema.String.check(
  Schema.isPattern(DOMAIN_NAME_PATTERN, {
    message: "Expected a plain DNS domain such as lndo.site, without a scheme, port, path, or wildcard.",
  }),
).annotate({
  identifier: "DomainName",
  title: "Domain Name",
  description:
    "Plain DNS domain without a scheme, port, path, or wildcard; dot-separated labels of letters, digits, and hyphens, at most 63 characters per label and 253 overall, without leading or trailing hyphens.",
});
export type DomainName = typeof DomainName.Type;

export const RoutePathPrefix = Schema.String.check(
  Schema.isPattern(ROUTE_PATH_PREFIX_PATTERN, {
    message: "Expected a path prefix beginning with /, without whitespace, a query string, or a fragment.",
  }),
).annotate({
  identifier: "RoutePathPrefix",
  title: "Route Path Prefix",
  description:
    "Request path prefix beginning with / and containing no whitespace, query string, or fragment.",
});
export type RoutePathPrefix = typeof RoutePathPrefix.Type;
