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

/**
 * The gateway sentinel a runtime resolves to the host's address when it creates
 * the container. Using it keeps core from guessing a numeric address.
 */
export const HOST_GATEWAY_TARGET = "host-gateway" as const;

/** Container variable naming the host alias; omitted when the host is unreachable. */
export const HOST_IP_ENV_KEY = "LANDO_HOST_IP" as const;

/**
 * Applies host reachability to a finalized service plan. The alias and its
 * variable exist only when the provider declares it can reach the host; a
 * provider that cannot is not an error, it simply produces neither.
 */
export const applyHostReachability = <
  T extends {
    readonly environment: Readonly<Record<string, string>>;
    readonly hostAliases: ReadonlyArray<{ readonly hostname: string; readonly ip: string }>;
  },
>(
  servicePlan: T,
  hostReachability: "native" | "emulated" | "none",
): T => {
  const others = servicePlan.hostAliases.filter((alias) => alias.hostname !== HOST_INTERNAL_ALIAS);
  const { [HOST_IP_ENV_KEY]: _existing, ...environment } = servicePlan.environment;
  if (hostReachability === "none") {
    return { ...servicePlan, environment, hostAliases: others };
  }
  return {
    ...servicePlan,
    environment: { ...environment, [HOST_IP_ENV_KEY]: HOST_INTERNAL_ALIAS },
    hostAliases: [...others, { hostname: HOST_INTERNAL_ALIAS, ip: HOST_GATEWAY_TARGET }],
  };
};
