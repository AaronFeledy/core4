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
 * Core-private ambient context tag carrying an already-resolved network-trust
 * object. Provided by callers that resolved trust (setup preflight); consumed
 * by `HttpClientLive`.
 */
export class NetworkTrust extends Context.Tag("@lando/core/NetworkTrust")<
  NetworkTrust,
  ResolvedNetworkTrust
>() {}
