import { mapFailures } from "@lando/sdk/command-result";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import { CliInvocation } from "../../runtime/invocation-context";

import { HttpTrustError, HttpTrustErrorKind } from "@lando/sdk/errors";
import type { GlobalConfig, NetworkConfig } from "@lando/sdk/schema";

import { RequestPolicy } from "@lando/http-client/live";
import {
  type LoadedCaPem,
  NetworkTrust,
  NetworkTrustResolutionError,
  type ResolvedNetworkTrust,
  loadCaPems,
  resolveNetworkTrustPlan,
} from "@lando/http-client/network-trust";

export class SetupNetworkTrustError extends Schema.TaggedError<SetupNetworkTrustError>()(
  "SetupNetworkTrustError",
  {
    kind: HttpTrustErrorKind,
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface ResolvedSetupNetworkTrust extends NetworkConfig {
  readonly proxy: {
    readonly http?: string;
    readonly https?: string;
    readonly noProxy: ReadonlyArray<string>;
    readonly injectIntoServices: boolean;
  };
  readonly ca: {
    readonly trustHost: boolean;
    readonly certs: ReadonlyArray<string>;
    readonly loadedCerts: ReadonlyArray<LoadedCaPem>;
    readonly injectIntoServices: boolean;
  };
}

export type SetupNetworkTrustProbe = (
  network: ResolvedSetupNetworkTrust,
) => Effect.Effect<void, SetupNetworkTrustError, HttpClient.HttpClient>;

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

const proxyAuthError = (cause?: unknown): SetupNetworkTrustError =>
  new SetupNetworkTrustError({
    kind: "proxy-authentication",
    message: "The configured proxy requires authentication before Lando can download setup artifacts.",
    remediation: `Update network.proxy in the global config, or HTTP_PROXY / HTTPS_PROXY, with valid proxy credentials. Proxy credentials are redacted from diagnostics. ${platformNetworkHint()}`,
    ...(cause === undefined ? {} : { cause }),
  });

const blockedEndpointError = (
  input: { readonly status?: number; readonly cause?: unknown } = {},
): SetupNetworkTrustError =>
  new SetupNetworkTrustError({
    kind: "blocked-endpoint",
    message:
      input.status === undefined
        ? "The setup artifact registry could not be reached through the configured network path."
        : `The setup artifact registry returned HTTP ${input.status} through the configured network path.`,
    remediation: `Allow GitHub release downloads and Lando runtime bundle URLs through the corporate proxy/firewall, or update network.proxy / HTTP_PROXY / HTTPS_PROXY / NO_PROXY. ${platformNetworkHint()}`,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });

/** Adapt setup's resolved trust onto the core-private `ResolvedNetworkTrust` consumed by `HttpClient`. */
export const networkTrustFromResolved = (network: ResolvedSetupNetworkTrust): ResolvedNetworkTrust => {
  // `injectIntoServices` is a service-planning flag; egress trust must not carry it.
  const { injectIntoServices: _injectIntoServices, ...proxy } = network.proxy;
  return {
    proxy,
    caPems: network.ca.loadedCerts.map((cert) => cert.pem),
    trustHost: network.ca.trustHost,
  };
};

const unwrapTransportCause = (error: unknown): unknown => {
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError")
    return error.reason.cause ?? error;
  return error;
};

const tlsInterceptionError = (
  kind: "tls-interception" | "missing-custom-ca",
  cause: unknown,
): SetupNetworkTrustError =>
  new SetupNetworkTrustError({
    kind,
    message: "TLS validation failed while checking setup download access.",
    remediation: `If a corporate TLS interceptor is present, add its root certificate to network.ca.certs or LANDO_NETWORK_CA_CERTS, then rerun \`lando setup\`. ${platformNetworkHint()}`,
    cause,
  });

const certificateInvalidError = (cause: unknown): SetupNetworkTrustError =>
  new SetupNetworkTrustError({
    kind: "certificate-invalid",
    message: "The setup download server's TLS certificate failed verification.",
    remediation:
      "The certificate is expired, not yet valid, issued for another host, or revoked; adding a CA does not fix it. Check the host clock and whether a captive portal or proxy is rewriting TLS, then rerun `lando setup`.",
    cause,
  });

const proxyReplyStatus = (trust: HttpTrustError): number | undefined => {
  const reply = trust.cause;
  return typeof reply === "object" && reply !== null && "status" in reply && typeof reply.status === "number"
    ? reply.status
    : undefined;
};

/** The HTTP client already classified the failure; map its kind instead of re-parsing text. */
const classifyTrustError = (trust: HttpTrustError, cause: unknown): SetupNetworkTrustError => {
  switch (trust.kind) {
    case "proxy-authentication":
      return proxyAuthError(cause);
    case "proxy-tunnel-refused": {
      const status = proxyReplyStatus(trust);
      return status === 407
        ? proxyAuthError(cause)
        : new SetupNetworkTrustError({
            kind: trust.kind,
            message: trust.message,
            remediation: trust.remediation,
            cause,
          });
    }
    case "tls-interception":
    case "missing-custom-ca":
      return tlsInterceptionError(trust.kind, cause);
    case "certificate-invalid":
      return certificateInvalidError(cause);
    case "blocked-endpoint":
      return blockedEndpointError({ cause });
  }
};

/** Trust kinds come only from the HTTP client's `HttpTrustError`; other failures are reachability. */
export const classifySetupNetworkFailure = (cause: unknown): SetupNetworkTrustError => {
  const unwrapped = unwrapTransportCause(cause);
  if (Schema.is(HttpTrustError)(unwrapped)) return classifyTrustError(unwrapped, cause);
  const status = HttpClientError.isHttpClientError(cause) ? cause.response?.status : undefined;
  if (status === 407) return proxyAuthError(cause);
  return blockedEndpointError({ cause, ...(status === undefined ? {} : { status }) });
};

export const resolveSetupNetworkTrust = Effect.fnUntraced(function* (
  config: GlobalConfig,
  env?: NodeJS.ProcessEnv,
): Effect.fn.Return<ResolvedSetupNetworkTrust, SetupNetworkTrustError> {
  const sourceEnv = env ?? (yield* CliInvocation).env;
  const plan = yield* Effect.try({
    try: () => resolveNetworkTrustPlan({ network: config.network }, sourceEnv),
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
            kind: "blocked-endpoint",
            message: "Network trust configuration could not be resolved.",
            remediation: platformNetworkHint(),
            cause,
          }),
  });

  const loadedCerts = yield* loadCaPems(plan.caCertPaths).pipe(
    mapFailures(
      (error) =>
        new SetupNetworkTrustError({
          kind: "missing-custom-ca",
          message: error.message,
          remediation: `${error.remediation} Then rerun \`lando setup\`.`,
          cause: error,
        }),
    ),
  );

  return {
    // Defaults are deliberately asymmetric: CA material is not secret so inject is on,
    // while proxy URLs may embed credentials so inject stays opt-in.
    proxy: {
      ...plan.proxy,
      injectIntoServices: config.network?.proxy?.injectIntoServices ?? false,
    },
    ca: {
      trustHost: plan.trustHost,
      certs: plan.caCertPaths,
      loadedCerts,
      injectIntoServices: config.network?.ca?.injectIntoServices ?? true,
    },
  };
});

export const defaultSetupNetworkTrustProbe: SetupNetworkTrustProbe = Effect.fn("SetupNetworkTrust.probe")(
  function* (network) {
    const hasTrustToValidate =
      network.proxy.http !== undefined ||
      network.proxy.https !== undefined ||
      network.ca.loadedCerts.length > 0 ||
      network.ca.trustHost === false;
    if (!hasTrustToValidate) return;

    const http = yield* HttpClient.HttpClient;
    const response = yield* http.head(SETUP_NETWORK_PROBE_URL).pipe(
      Effect.provideService(RequestPolicy, { redirect: "manual" }),
      Effect.provideService(NetworkTrust, networkTrustFromResolved(network)),
      Effect.catch((error) => Effect.fail(classifySetupNetworkFailure(error))),
    );
    if (response.status === 407) return yield* Effect.fail(proxyAuthError());
    if (response.status < 200 || response.status >= 400) {
      return yield* Effect.fail(blockedEndpointError({ status: response.status }));
    }
  },
);

export const validateSetupNetworkTrust = Effect.fnUntraced(function* (
  config: GlobalConfig,
  probe?: SetupNetworkTrustProbe,
): Effect.fn.Return<ResolvedSetupNetworkTrust, SetupNetworkTrustError, HttpClient.HttpClient> {
  const resolved = yield* resolveSetupNetworkTrust(config);
  // The probe returns a classified SetupNetworkTrustError; re-classifying its
  // message here would downgrade proxy-authentication to blocked-endpoint.
  yield* (probe ?? defaultSetupNetworkTrustProbe)(resolved);
  return resolved;
});
