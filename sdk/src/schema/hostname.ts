import { Schema } from "effect";

// ============================================================================
// Concrete route hostnames, DNS domains, host-alias names, certificate names,
// and request path prefixes
// ============================================================================

export const ROUTE_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9*](?:[A-Za-z0-9*-]{0,61}[A-Za-z0-9*])?(?:\.[A-Za-z0-9*](?:[A-Za-z0-9*-]{0,61}[A-Za-z0-9*])?)*(?![\s\S])/u;
export const DOMAIN_NAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?![\s\S])/u;
const HOST_ALIAS_LABEL = "[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?";
export const HOST_ALIAS_NAME_PATTERN = new RegExp(
  `^(?=.{1,253}$)${HOST_ALIAS_LABEL}(?:\\.${HOST_ALIAS_LABEL})*(?![\\s\\S])`,
  "u",
);
const CERTIFICATE_DNS_PATTERN = new RegExp(
  `^(?=.{1,253}$)(?:\\*\\.)?${HOST_ALIAS_LABEL}(?:\\.${HOST_ALIAS_LABEL})*(?![\\s\\S])`,
  "u",
);
export const ROUTE_PATH_PREFIX_PATTERN = /^\/[^\s?#]*(?![\s\S])/u;

const IPV4_LITERAL_PATTERN = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/u;

const isIpv4Literal = (value: string): boolean =>
  IPV4_LITERAL_PATTERN.test(value) && value.split(".").every((part) => Number(part) <= 255);

const isIpv6Literal = (value: string): boolean => {
  if (!value.includes(":") || !/^[A-Fa-f0-9:.]+(?![\s\S])/u.test(value)) {
    return false;
  }
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
};

const isCertificateName = (value: string): boolean =>
  CERTIFICATE_DNS_PATTERN.test(value) || isIpv4Literal(value) || isIpv6Literal(value);

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

export const HostAliasName = Schema.String.check(
  Schema.isPattern(HOST_ALIAS_NAME_PATTERN, {
    message:
      "Expected a host-alias name such as host.lando.internal or my_db, without a wildcard, scheme, port, path, whitespace, or trailing dot.",
  }),
).annotate({
  identifier: "HostAliasName",
  title: "Host Alias Name",
  description:
    "DNS-shaped name for /etc/hosts and Compose aliases: letters, digits, hyphens, and underscores; no wildcard, scheme, port, path, whitespace, or trailing dot; at most 63 characters per label and 253 overall, without leading or trailing hyphens.",
});
export type HostAliasName = typeof HostAliasName.Type;

export const CertificateName = Schema.String.check(
  Schema.makeFilter(isCertificateName, {
    message:
      "Expected a certificate name: an unbracketed IPv4/IPv6 literal, or a DNS name with an optional leftmost *. wildcard label (ASCII only).",
    toJsonSchema: () => ({
      anyOf: [
        { pattern: CERTIFICATE_DNS_PATTERN.source },
        { format: "ipv4" },
        { format: "ipv6", pattern: "^[A-Fa-f0-9:.]+(?![\\s\\S])" },
      ],
    }),
  }),
).annotate({
  identifier: "CertificateName",
  title: "Certificate Name",
  description:
    "Leaf certificate identity: an unbracketed IPv4 or IPv6 literal (no port or zone id), or a HostAliasName-grammar DNS name optionally prefixed by *. as the whole leftmost label. ASCII only; case-insensitive.",
});
export type CertificateName = typeof CertificateName.Type;

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

/**
 * Map a route hostname to the certificate identity that covers it.
 *
 * Valid certificate names pass through. When every `*` sits in the leftmost
 * label only, the broader leftmost wildcard SAN (`*.<rest>`) covers every host
 * Traefik's `*` matcher can select. A `*` in any lower label cannot be covered
 * and returns `undefined`.
 */
export const certificateNameForHostname = (hostname: string): CertificateName | undefined => {
  if (isCertificateName(hostname)) return hostname;
  if (!Schema.is(RouteHostname)(hostname)) return undefined;
  const candidate = `*.${hostname.split(".").slice(1).join(".")}`;
  return isCertificateName(candidate) ? candidate : undefined;
};
