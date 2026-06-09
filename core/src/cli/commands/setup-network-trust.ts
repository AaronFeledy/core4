import { readFile } from "node:fs/promises";

import { Data, Effect } from "effect";

import type { GlobalConfig, NetworkConfig } from "@lando/sdk/schema";

export type SetupNetworkFailureKind =
  | "tls-interception"
  | "proxy-authentication"
  | "missing-custom-ca"
  | "blocked-registry";

export class SetupNetworkTrustError extends Data.TaggedError("SetupNetworkTrustError")<{
  readonly kind: SetupNetworkFailureKind;
  readonly message: string;
  readonly remediation: string;
  readonly cause?: unknown;
}> {}

export interface LoadedNetworkCaCert {
  readonly path: string;
  readonly pem: string;
}

export interface ResolvedSetupNetworkTrust extends NetworkConfig {
  readonly proxy: {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy: ReadonlyArray<string>;
  };
  readonly ca: {
    readonly trustHost: boolean;
    readonly certs: ReadonlyArray<string>;
    readonly loadedCerts: ReadonlyArray<LoadedNetworkCaCert>;
  };
}

export type SetupNetworkTrustProbe = (
  network: ResolvedSetupNetworkTrust,
) => Effect.Effect<void, SetupNetworkTrustError>;

export type SetupNetworkTrustFetch = (
  input: string | URL | Request,
  init?: BunFetchRequestInit,
) => Promise<Response>;

const SETUP_NETWORK_PROBE_URL = "https://github.com/";

const platformNetworkHint = (): string => {
  switch (process.platform) {
    case "darwin":
      return "On macOS, export proxy variables in the shell that runs Lando or set network.proxy, and point network.ca.certs/LANDO_NETWORK_CA_CERTS at readable PEM files for intercepted TLS.";
    case "win32":
      return "On Windows, set user or process HTTP_PROXY/HTTPS_PROXY/NO_PROXY values or network.proxy, and point network.ca.certs/LANDO_NETWORK_CA_CERTS at readable PEM files.";
    default:
      return "On Linux, export HTTP_PROXY/HTTPS_PROXY/NO_PROXY in the shell that runs Lando or set network.proxy, and point network.ca.certs/LANDO_NETWORK_CA_CERTS at readable PEM files.";
  }
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

const proxyConfigHasExplicitValue = (proxy: GlobalConfig["network"] extends infer N ? N : never): boolean => {
  if (proxy === undefined || typeof proxy !== "object" || proxy === null || !("proxy" in proxy)) return false;
  const candidate = proxy.proxy;
  if (candidate === undefined) return false;
  return (
    (typeof candidate.http === "string" && candidate.http.length > 0) ||
    (typeof candidate.https === "string" && candidate.https.length > 0) ||
    (candidate.noProxy?.length ?? 0) > 0
  );
};

const parseEnvCaCerts = (
  raw: string | undefined,
): Effect.Effect<ReadonlyArray<string>, SetupNetworkTrustError> =>
  Effect.try({
    try: () => {
      if (raw === undefined || raw.trim() === "") return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
        throw new Error("LANDO_NETWORK_CA_CERTS must be a JSON array of certificate paths.");
      }
      return parsed;
    },
    catch: (cause) =>
      new SetupNetworkTrustError({
        kind: "missing-custom-ca",
        message: "LANDO_NETWORK_CA_CERTS is not a JSON array of custom CA certificate paths.",
        remediation:
          'Set LANDO_NETWORK_CA_CERTS to a JSON array such as `["/path/to/corp-root.pem"]`, or configure network.ca.certs in the global config.',
        cause,
      }),
  });

const loadCustomCa = (path: string): Effect.Effect<LoadedNetworkCaCert, SetupNetworkTrustError> =>
  Effect.tryPromise({
    try: async () => ({ path, pem: await readFile(path, "utf-8") }),
    catch: (cause) =>
      new SetupNetworkTrustError({
        kind: "missing-custom-ca",
        message: `Custom CA certificate could not be read: ${path}`,
        remediation: `Fix network.ca.certs in the global config or LANDO_NETWORK_CA_CERTS so every path points to a readable PEM certificate, then rerun \`lando setup\`. ${platformNetworkHint()}`,
        cause,
      }),
  });

const shouldBypassProxy = (url: string, noProxy: ReadonlyArray<string>): boolean => {
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

const fetchInitForNetwork = (
  url: string,
  network: ResolvedSetupNetworkTrust,
): BunFetchRequestInit | undefined => {
  const parsedUrl = new URL(url);
  const bypassProxy = shouldBypassProxy(url, network.proxy.noProxy);
  const proxyCandidate = bypassProxy
    ? undefined
    : parsedUrl.protocol === "https:"
      ? (network.proxy.https ?? network.proxy.http)
      : (network.proxy.http ?? network.proxy.https);
  const proxy = typeof proxyCandidate === "string" && proxyCandidate.length > 0 ? proxyCandidate : undefined;
  const ca = network.ca.loadedCerts.map((cert) => cert.pem);
  if (proxy === undefined && ca.length === 0) return undefined;
  return {
    ...(proxy === undefined ? {} : { proxy }),
    ...(ca.length === 0 ? {} : { tls: { ca } }),
  };
};

export const classifySetupNetworkFailure = (cause: unknown): SetupNetworkTrustError => {
  const text = cause instanceof Error ? `${cause.name} ${cause.message}` : String(cause);
  const lower = text.toLowerCase();
  if (lower.includes("407") || lower.includes("proxy authentication")) {
    return new SetupNetworkTrustError({
      kind: "proxy-authentication",
      message: "The configured proxy requires authentication before Lando can download setup artifacts.",
      remediation: `Update network.proxy in the global config, or HTTP_PROXY / HTTPS_PROXY, with valid proxy credentials. Proxy credentials are redacted from diagnostics. ${platformNetworkHint()}`,
      cause,
    });
  }
  if (lower.includes("certificate") || lower.includes("tls") || lower.includes("self signed")) {
    return new SetupNetworkTrustError({
      kind: "tls-interception",
      message: "TLS validation failed while checking setup download access.",
      remediation: `If a corporate TLS interceptor is present, add its root certificate to network.ca.certs or LANDO_NETWORK_CA_CERTS, then rerun \`lando setup\`. ${platformNetworkHint()}`,
      cause,
    });
  }
  return new SetupNetworkTrustError({
    kind: "blocked-registry",
    message: "The setup artifact registry could not be reached through the configured network path.",
    remediation: `Allow GitHub release downloads and Lando runtime bundle URLs through the corporate proxy/firewall, or update network.proxy / HTTP_PROXY / HTTPS_PROXY / NO_PROXY. ${platformNetworkHint()}`,
    cause,
  });
};

export const resolveSetupNetworkTrust = (
  config: GlobalConfig,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ResolvedSetupNetworkTrust, SetupNetworkTrustError> =>
  Effect.gen(function* () {
    const network = config.network;
    const useConfigProxy = proxyConfigHasExplicitValue(network);
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

    const envCerts = yield* parseEnvCaCerts(env.LANDO_NETWORK_CA_CERTS);
    const certs = [...(network?.ca?.certs ?? []), ...envCerts];
    const loadedCerts = yield* Effect.all(certs.map(loadCustomCa), { concurrency: "unbounded" });

    return {
      proxy: {
        ...(http === undefined ? {} : { http }),
        ...(https === undefined ? {} : { https }),
        noProxy,
      },
      ca: {
        trustHost: network?.ca?.trustHost ?? true,
        certs,
        loadedCerts,
      },
    };
  });

export const makeSetupNetworkTrustProbe =
  (fetchImpl: SetupNetworkTrustFetch = globalThis.fetch): SetupNetworkTrustProbe =>
  (network) => {
    const hasTrustToValidate =
      network.proxy.http !== undefined ||
      network.proxy.https !== undefined ||
      network.ca.loadedCerts.length > 0;
    if (!hasTrustToValidate) return Effect.void;

    return Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(SETUP_NETWORK_PROBE_URL, {
          method: "HEAD",
          redirect: "manual",
          ...fetchInitForNetwork(SETUP_NETWORK_PROBE_URL, network),
        });
        if (response.status === 407) {
          throw new Error(`HTTP 407 Proxy Authentication Required probing ${SETUP_NETWORK_PROBE_URL}`);
        }
        if (!response.ok && (response.status < 300 || response.status >= 400)) {
          throw new Error(
            `HTTP ${response.status} ${response.statusText} probing ${SETUP_NETWORK_PROBE_URL}`,
          );
        }
      },
      catch: classifySetupNetworkFailure,
    });
  };

export const defaultSetupNetworkTrustProbe: SetupNetworkTrustProbe = makeSetupNetworkTrustProbe();

export const validateSetupNetworkTrust = (
  config: GlobalConfig,
  probe?: SetupNetworkTrustProbe,
): Effect.Effect<ResolvedSetupNetworkTrust, SetupNetworkTrustError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveSetupNetworkTrust(config);
    yield* (probe ?? defaultSetupNetworkTrustProbe)(resolved).pipe(
      Effect.mapError(classifySetupNetworkFailure),
    );
    return resolved;
  });
