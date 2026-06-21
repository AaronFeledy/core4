/**
 * Core-private network-trust seam.
 *
 * This is the single source of truth for outbound proxy/CA application used by
 * the `HttpClient` egress chokepoint (and therefore by `Downloader`). It is
 * intentionally NOT published from `@lando/sdk` and NOT re-exported from
 * `core/src/services/index.ts`.
 *
 * Trust is carried as an already-resolved object through the core-private
 * `NetworkTrust` context tag. A caller that has computed trust (e.g. `lando
 * setup`'s network preflight) provides the tag around its download/stream
 * effect; `HttpClientBasicLive.stream` reads it via `Effect.serviceOption` and
 * applies Bun `fetch` `proxy`/`tls.ca` options. When the tag is absent the
 * fetch stays a bare request, byte-for-byte the prior behavior.
 *
 * A full config-driven resolver (proxy precedence, `NO_PROXY`, CA loading) may
 * ship on the public HttpClient surface later; this module only carries the
 * resolved shape and Bun `fetch` application helpers.
 */
import { Context } from "effect";

/** Already-resolved outbound network trust. */
export interface ResolvedNetworkTrust {
  readonly proxy: {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy: ReadonlyArray<string>;
  };
  /** Custom CA certificates as PEM strings. */
  readonly caPems: ReadonlyArray<string>;
}

/**
 * Core-private ambient context tag carrying an already-resolved network-trust
 * object. Provided by callers that resolved trust (setup preflight); consumed
 * by `HttpClientBasicLive`.
 */
export class NetworkTrust extends Context.Tag("@lando/core/NetworkTrust")<
  NetworkTrust,
  ResolvedNetworkTrust
>() {}

/** Whether the URL host matches a `NO_PROXY` pattern and should bypass the proxy. */
export const shouldBypassProxy = (url: string, noProxy: ReadonlyArray<string>): boolean => {
  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname.toLowerCase();
  const port = parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80");
  const hostWithPort = `${host}:${port}`;
  return noProxy.some((raw) => {
    const pattern = raw.toLowerCase();
    if (pattern === "*") return true;
    if (pattern === host || pattern === hostWithPort) return true;
    if (pattern.startsWith(".")) return host.endsWith(pattern);
    return host.endsWith(`.${pattern}`);
  });
};

/**
 * Build the Bun `fetch` init (proxy + `tls.ca`) for a URL under resolved trust,
 * or `undefined` when no proxy/CA applies (so the fetch stays bare).
 */
export const fetchInitForNetwork = (
  url: string,
  trust: ResolvedNetworkTrust,
): BunFetchRequestInit | undefined => {
  const parsedUrl = new URL(url);
  const bypassProxy = shouldBypassProxy(url, trust.proxy.noProxy);
  const proxyCandidate = bypassProxy
    ? undefined
    : parsedUrl.protocol === "https:"
      ? (trust.proxy.https ?? trust.proxy.http)
      : (trust.proxy.http ?? trust.proxy.https);
  const proxy = typeof proxyCandidate === "string" && proxyCandidate.length > 0 ? proxyCandidate : undefined;
  const ca = [...trust.caPems];
  if (proxy === undefined && ca.length === 0) return undefined;
  return {
    ...(proxy === undefined ? {} : { proxy }),
    ...(ca.length === 0 ? {} : { tls: { ca } }),
  };
};
