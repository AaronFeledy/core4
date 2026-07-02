import { readFile } from "node:fs/promises";

import { Data, Effect } from "effect";

import type { GlobalConfig, NetworkConfig } from "@lando/sdk/schema";
import { HttpClient } from "@lando/sdk/services";

import {
  NetworkTrust,
  NetworkTrustResolutionError,
  type ResolvedNetworkTrust,
  resolveNetworkTrustPlan,
} from "../../http-client/network-trust.ts";

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
) => Effect.Effect<void, SetupNetworkTrustError, HttpClient>;

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

/** Adapt setup's resolved trust onto the core-private `ResolvedNetworkTrust` consumed by `HttpClient`. */
export const networkTrustFromResolved = (network: ResolvedSetupNetworkTrust): ResolvedNetworkTrust => ({
  proxy: network.proxy,
  caPems: network.ca.loadedCerts.map((cert) => cert.pem),
  trustHost: network.ca.trustHost,
});

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
    const plan = yield* Effect.try({
      try: () => resolveNetworkTrustPlan({ network: config.network }, env),
      catch: (cause) =>
        cause instanceof NetworkTrustResolutionError
          ? new SetupNetworkTrustError({
              kind: "missing-custom-ca",
              message: "LANDO_NETWORK_CA_CERTS is not a JSON array of custom CA certificate paths.",
              remediation:
                'Set LANDO_NETWORK_CA_CERTS to a JSON array such as `["/path/to/corp-root.pem"]`, or configure network.ca.certs in the global config.',
              cause,
            })
          : new SetupNetworkTrustError({
              kind: "blocked-registry",
              message: "Network trust configuration could not be resolved.",
              remediation: platformNetworkHint(),
              cause,
            }),
    });

    const loadedCerts = yield* Effect.all(plan.caCertPaths.map(loadCustomCa), { concurrency: "unbounded" });

    return {
      proxy: plan.proxy,
      ca: {
        trustHost: plan.trustHost,
        certs: plan.caCertPaths,
        loadedCerts,
      },
    };
  });

const blockedRegistryError = (status: number): SetupNetworkTrustError =>
  new SetupNetworkTrustError({
    kind: "blocked-registry",
    message: `The setup artifact registry returned HTTP ${status} through the configured network path.`,
    remediation: `Allow GitHub release downloads and Lando runtime bundle URLs through the corporate proxy/firewall, or update network.proxy / HTTP_PROXY / HTTPS_PROXY / NO_PROXY. ${platformNetworkHint()}`,
  });

const proxyAuthError = (): SetupNetworkTrustError =>
  new SetupNetworkTrustError({
    kind: "proxy-authentication",
    message: "The configured proxy requires authentication before Lando can download setup artifacts.",
    remediation: `Update network.proxy in the global config, or HTTP_PROXY / HTTPS_PROXY, with valid proxy credentials. Proxy credentials are redacted from diagnostics. ${platformNetworkHint()}`,
  });

export const defaultSetupNetworkTrustProbe: SetupNetworkTrustProbe = (network) =>
  Effect.gen(function* () {
    const hasTrustToValidate =
      network.proxy.http !== undefined ||
      network.proxy.https !== undefined ||
      network.ca.loadedCerts.length > 0 ||
      network.ca.trustHost === false;
    if (!hasTrustToValidate) return;

    const http = yield* HttpClient;
    const response = yield* Effect.scoped(
      http.request({ url: SETUP_NETWORK_PROBE_URL, method: "HEAD", redirect: "manual" }),
    ).pipe(
      Effect.provideService(NetworkTrust, networkTrustFromResolved(network)),
      Effect.catchAll((error) => {
        if (error._tag === "HttpTrustError") return Effect.fail(classifySetupNetworkFailure(error));
        if (error._tag === "HttpRequestError") {
          return Effect.fail(
            error.status === 407 ? proxyAuthError() : classifySetupNetworkFailure(error.cause ?? error),
          );
        }
        return Effect.fail(classifySetupNetworkFailure(error));
      }),
    );
    if (response.status === 407) return yield* Effect.fail(proxyAuthError());
    if (response.status < 200 || response.status >= 400) {
      return yield* Effect.fail(blockedRegistryError(response.status));
    }
  });

export const makeSetupNetworkTrustProbe = (): SetupNetworkTrustProbe => defaultSetupNetworkTrustProbe;

export const validateSetupNetworkTrust = (
  config: GlobalConfig,
  probe?: SetupNetworkTrustProbe,
): Effect.Effect<ResolvedSetupNetworkTrust, SetupNetworkTrustError, HttpClient> =>
  Effect.gen(function* () {
    const resolved = yield* resolveSetupNetworkTrust(config);
    // The probe returns a classified SetupNetworkTrustError; re-classifying its
    // message here would downgrade proxy-authentication to blocked-registry.
    yield* (probe ?? defaultSetupNetworkTrustProbe)(resolved);
    return resolved;
  });
