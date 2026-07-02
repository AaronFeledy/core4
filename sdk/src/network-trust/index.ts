/**
 * Canonical pure outbound network-trust resolver.
 *
 * This is the single source of truth for proxy precedence, `NO_PROXY` matching,
 * and Bun `fetch` proxy/CA application used by every Lando-owned egress path
 * (`HttpClientLive`, and therefore `Downloader`, plus `lando setup` preflight).
 *
 * The module is intentionally PURE: string/URL/config logic only, no `node:fs`,
 * no `Effect`. CA certificates are referenced by PATH in the resolved PLAN
 * (`resolveNetworkTrustPlan`); reading those paths into PEM strings is an IO
 * concern that lives in the consuming runtime (core). A consumer reads the PEMs
 * and assembles the applied {@link ResolvedNetworkTrust} object, which
 * {@link fetchInitForNetwork} turns into a Bun `fetch` init.
 */

import type { NetworkConfig } from "../schema/config.ts";

/** Already-resolved, already-loaded outbound network trust applied to a fetch. */
export interface ResolvedNetworkTrust {
  readonly proxy: {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy: ReadonlyArray<string>;
  };
  /** Custom CA certificates as PEM strings (already read from disk). */
  readonly caPems: ReadonlyArray<string>;
  /**
   * Whether the host default trust store is merged in (`network.ca.trustHost`).
   * When `true`, `fetchInitForNetwork` prepends the injected host root PEMs so
   * both default roots and custom CAs are trusted. When `false`, only the custom
   * CAs apply (an empty list fails closed and trusts nothing).
   */
  readonly trustHost: boolean;
}

/**
 * A resolved trust PLAN: proxy precedence and `NO_PROXY` are fully decided, but
 * CA certificates are still referenced by path. Reading the paths is the
 * consumer's IO step; the result becomes a {@link ResolvedNetworkTrust}.
 */
export interface NetworkTrustPlan {
  readonly proxy: {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy: ReadonlyArray<string>;
  };
  /** CA certificate file paths (config first, then env), to be read by the consumer. */
  readonly caCertPaths: ReadonlyArray<string>;
  /** Whether the host trust store should also be trusted (`network.ca.trustHost`). */
  readonly trustHost: boolean;
}

/** Subset of global config the resolver reads. */
export interface NetworkTrustConfigInput {
  readonly network?: NetworkConfig | undefined;
}

/** Raised when `LANDO_NETWORK_CA_CERTS` is present but not a JSON array of paths. */
export class NetworkTrustResolutionError extends Error {
  readonly _tag = "NetworkTrustResolutionError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NetworkTrustResolutionError";
  }
}

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
 *
 * Bun's `tls.ca` replaces the default trust store, so `systemCaPems` (the host's
 * default root PEMs, read by the consumer) are merged in when `trust.trustHost`
 * is enabled. The resulting `tls.ca` is omitted only when the fetch would trust
 * exactly the default store (`trustHost` with no custom CAs); every other case
 * sets an explicit list so trust is never silently widened.
 */
export const fetchInitForNetwork = (
  url: string,
  trust: ResolvedNetworkTrust,
  systemCaPems: ReadonlyArray<string>,
): BunFetchRequestInit | undefined => {
  const parsedUrl = new URL(url);
  const bypassProxy = shouldBypassProxy(url, trust.proxy.noProxy);
  const proxyCandidate = bypassProxy
    ? undefined
    : parsedUrl.protocol === "https:"
      ? (trust.proxy.https ?? trust.proxy.http)
      : (trust.proxy.http ?? trust.proxy.https);
  const proxy = typeof proxyCandidate === "string" && proxyCandidate.length > 0 ? proxyCandidate : undefined;
  const customCa = [...trust.caPems];
  const omitCa = trust.trustHost && customCa.length === 0;
  const ca = trust.trustHost ? [...systemCaPems, ...customCa] : customCa;
  if (proxy === undefined && omitCa) return undefined;
  return {
    ...(proxy === undefined ? {} : { proxy }),
    ...(omitCa ? {} : { tls: { ca } }),
  };
};

const firstEnv = (env: NodeJS.ProcessEnv, names: ReadonlyArray<string>): string | undefined => {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
};

const splitNoProxy = (value: string | undefined): ReadonlyArray<string> =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

const configProxyHasExplicitValue = (network: NetworkConfig | undefined): boolean => {
  const candidate = network?.proxy;
  if (candidate === undefined) return false;
  return (
    (typeof candidate.http === "string" && candidate.http.length > 0) ||
    (typeof candidate.https === "string" && candidate.https.length > 0) ||
    (candidate.noProxy?.length ?? 0) > 0
  );
};

const parseEnvCaCertPaths = (raw: string | undefined): ReadonlyArray<string> => {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new NetworkTrustResolutionError(
      "LANDO_NETWORK_CA_CERTS is not valid JSON; expected a JSON array of certificate paths.",
      { cause },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new NetworkTrustResolutionError(
      "LANDO_NETWORK_CA_CERTS must be a JSON array of certificate paths.",
    );
  }
  return parsed;
};

/**
 * Resolve a {@link NetworkTrustPlan} from global config and the environment.
 *
 * Proxy precedence: an explicit `network.proxy` in config wins over the
 * `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (and lowercase) environment variables.
 * A `null` config proxy value disables that proxy without falling back to env.
 * CA certificate paths are collected config-first then env (`LANDO_NETWORK_CA_CERTS`).
 *
 * Pure: returns paths, never reads files. The consumer reads the PEMs and builds
 * a {@link ResolvedNetworkTrust}.
 */
export const resolveNetworkTrustPlan = (
  config: NetworkTrustConfigInput,
  env: NodeJS.ProcessEnv = process.env,
): NetworkTrustPlan => {
  const network = config.network;
  const useConfigProxy = configProxyHasExplicitValue(network);
  const http = useConfigProxy
    ? network?.proxy?.http === null
      ? undefined
      : network?.proxy?.http
    : firstEnv(env, ["HTTP_PROXY", "http_proxy"]);
  const https = useConfigProxy
    ? network?.proxy?.https === null
      ? undefined
      : network?.proxy?.https
    : firstEnv(env, ["HTTPS_PROXY", "https_proxy"]);
  const noProxy = useConfigProxy
    ? (network?.proxy?.noProxy ?? [])
    : splitNoProxy(firstEnv(env, ["NO_PROXY", "no_proxy"]));

  const envCertPaths = parseEnvCaCertPaths(env.LANDO_NETWORK_CA_CERTS);
  const caCertPaths = [...(network?.ca?.certs ?? []), ...envCertPaths];

  return {
    proxy: {
      ...(http === undefined ? {} : { http }),
      ...(https === undefined ? {} : { https }),
      noProxy,
    },
    caCertPaths,
    trustHost: network?.ca?.trustHost ?? true,
  };
};
