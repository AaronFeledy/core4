/**
 * Networking intent.
 *
 * Core defines network *intent*, not implementation. The `RuntimeProvider`
 * is responsible for realizing the intent.
 *
 * Required behaviors (provider-implemented when capability allows):
 * - Services in an app resolve each other by service name (`<service>`)
 *   when the provider supports app networking.
 * - Cross-app service names use `<service>.<app>.internal` when the
 *   provider supports `sharedCrossAppNetwork`.
 * - `host.lando.internal` resolves to the host gateway when
 *   `hostReachability` is `native` or `emulated`. `LANDO_HOST_IP` is set
 *   to the resolvable name (not necessarily a numeric IP).
 * - Providers without shared networking MUST report
 *   `sharedCrossAppNetwork: false`. Features depending on it produce
 *   actionable errors.
 * - Host-exposed endpoints bind to `127.0.0.1` by default. LAN exposure
 *   is opt-in via `bindAddress`.
 *
 * **There is no built-in concept of a "shared bridge network" in core.**
 * Providers that need one create and manage it themselves; the docker
 * provider creates `lando_bridge_network` as an implementation detail.
 */

export const HOST_INTERNAL_ALIAS = "host.lando.internal" as const;
export const DEFAULT_BIND_ADDRESS = "127.0.0.1" as const;
