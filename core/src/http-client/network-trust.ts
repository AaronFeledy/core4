/**
 * Core-private network-trust seam.
 *
 * The proxy/CA application logic (`shouldBypassProxy`, `fetchInitForNetwork`)
 * and the resolved-trust shape (`ResolvedNetworkTrust`) are now the canonical
 * pure `@lando/sdk/network-trust` module, consumed by both `HttpClientLive` and
 * `lando setup` preflight. This module re-exports them for core-internal
 * callers and owns only the core-private ambient `NetworkTrust` context tag.
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
import tls from "node:tls";

import { Context } from "effect";

import type { ResolvedNetworkTrust } from "@lando/sdk/network-trust";

export type { ResolvedNetworkTrust } from "@lando/sdk/network-trust";
export {
  fetchInitForNetwork,
  NetworkTrustResolutionError,
  resolveNetworkTrustPlan,
  shouldBypassProxy,
  type NetworkTrustPlan,
} from "@lando/sdk/network-trust";

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
