/**
 * Core-private network-trust seam.
 *
 * The proxy/CA application logic (`shouldBypassProxy`, `fetchInitForNetwork`)
 * and the resolved-trust shape (`ResolvedNetworkTrust`) are now the canonical
 * pure `@lando/sdk/network-trust` module, consumed by both `HttpClientLive` and
 * `lando setup` preflight. This module re-exports them for core-internal
 * callers and owns core's PEM-loading, service-inject resolution, and ambient
 * `NetworkTrust` context seams.
 *
 * Trust is carried as an already-resolved, already-loaded object through the
 * `NetworkTrust` tag. A caller that has computed trust (e.g. `lando setup`'s
 * network preflight) provides the tag around its egress effect; `HttpClientLive`
 * reads it via `Effect.serviceOption` and applies Bun `fetch` `proxy`/`tls.ca`
 * options. When the tag is absent the client self-resolves from config/env or
 * stays a bare request.
 *
 * The tag is intentionally NOT published from `@lando/sdk` and NOT re-exported
 * from `core/src/services/index.ts`: it is the in-process injection mechanism,
 * not a public contract.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import tls from "node:tls";

import { Context, Effect, Schema } from "effect";

import {
  type NetworkTrustPlan,
  type ResolvedNetworkTrust,
  resolveNetworkTrustPlan,
} from "@lando/sdk/network-trust";
import type { NetworkConfig, ServiceConfig } from "@lando/sdk/schema";

export type { ResolvedNetworkTrust } from "@lando/sdk/network-trust";
export {
  fetchInitForNetwork,
  NetworkTrustResolutionError,
  shouldBypassProxy,
} from "@lando/sdk/network-trust";
export { resolveNetworkTrustPlan };
export type { NetworkTrustPlan };

export class CaPemLoadError extends Schema.TaggedError<CaPemLoadError>()("CaPemLoadError", {
  message: Schema.String,
  path: Schema.String,
  remediation: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface LoadedCaPem {
  readonly path: string;
  readonly pem: string;
  readonly digest: string;
}

export const loadCaPems = (
  paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<LoadedCaPem>, CaPemLoadError> =>
  Effect.all(
    paths.map((path) =>
      Effect.tryPromise({
        try: () => readFile(path, "utf-8"),
        catch: (cause) =>
          new CaPemLoadError({
            message: `CA certificate could not be read: ${path}`,
            path,
            remediation:
              "Point network.ca.certs or LANDO_NETWORK_CA_CERTS at readable host CA files, or fix the Landofile security.ca path.",
            cause,
          }),
      }).pipe(
        Effect.map((pem) => ({
          path,
          pem,
          digest: createHash("sha256").update(pem, "utf-8").digest("hex"),
        })),
      ),
    ),
    { concurrency: "unbounded" },
  );

interface ServiceNetworkInjectInput {
  readonly network?: NetworkConfig | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly security?: ServiceConfig["security"] | undefined;
  readonly plan?: NetworkTrustPlan | undefined;
}

interface ResolvedServiceNetworkInject {
  readonly injectCa: boolean;
  readonly injectProxy: boolean;
  readonly caPaths: ReadonlyArray<string>;
  readonly landofileCaPaths: NonNullable<ServiceConfig["security"]>["ca"];
  readonly proxy: NetworkTrustPlan["proxy"];
}

export const resolveServiceNetworkInject = (
  input: ServiceNetworkInjectInput,
): ResolvedServiceNetworkInject => {
  const plan = input.plan ?? resolveNetworkTrustPlan({ network: input.network }, input.env);
  const injectCa = input.security?.inheritNetworkCa ?? input.network?.ca?.injectIntoServices ?? true;
  const injectProxy =
    input.security?.inheritNetworkProxy ?? input.network?.proxy?.injectIntoServices ?? false;
  return {
    injectCa,
    injectProxy,
    caPaths: injectCa ? plan.caCertPaths : [],
    landofileCaPaths: input.security?.ca ?? [],
    proxy: plan.proxy,
  };
};

/**
 * Supplies the host default CA roots (PEM strings) that `fetchInitForNetwork`
 * merges in when `network.ca.trustHost` is enabled. Injected so the pure SDK
 * resolver never reads `node:tls`, and so tests can pass deterministic roots.
 */
export type SystemCaProvider = () => ReadonlyArray<string>;

/**
 * Reads the runtime's effective default CA store once and caches it.
 * `tls.getCACertificates("default")` (Bun/Node 22.15+) reflects OS-store roots;
 * older runtimes fall back to the bundled Mozilla roots (`tls.rootCertificates`).
 */
export const defaultSystemCaPems: SystemCaProvider = (() => {
  let cached: ReadonlyArray<string> | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const tlsWithDefault = tls as typeof tls & {
      getCACertificates?: (type?: "default") => ReadonlyArray<string>;
    };
    cached =
      typeof tlsWithDefault.getCACertificates === "function"
        ? [...tlsWithDefault.getCACertificates("default")]
        : [...tls.rootCertificates];
    return cached;
  };
})();

/**
 * Core-private ambient context tag carrying an already-resolved network-trust
 * object. Provided by callers that resolved trust (setup preflight); consumed
 * by `HttpClientLive`.
 */
export class NetworkTrust extends Context.Tag("@lando/core/NetworkTrust")<
  NetworkTrust,
  ResolvedNetworkTrust
>() {}
