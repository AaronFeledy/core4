import { ProxyError } from "@lando/sdk/errors";
import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";
import { Effect } from "effect";

export const selectRouterContribution = <
  A extends {
    readonly id: string;
    readonly defaultFor?: { readonly platform?: readonly string[] | undefined };
  },
>(options: {
  readonly contributions: readonly A[];
  readonly configured: string | undefined;
  readonly platform: HostPlatform;
}): Effect.Effect<A, ProxyError> => {
  const selected =
    options.configured === undefined
      ? undefined
      : options.contributions.findLast(({ id }) => id === options.configured);
  if (selected !== undefined) return Effect.succeed(selected);
  if (options.configured === undefined) {
    const defaults = options.contributions.filter((entry) =>
      entry.defaultFor?.platform?.includes(hostPlatformFamily(options.platform)),
    );
    const candidates = defaults.length === 1 ? defaults : options.contributions;
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate !== undefined) return Effect.succeed(candidate);
  }
  return Effect.fail(
    new ProxyError({
      proxyId: options.configured ?? "unknown",
      message:
        options.configured === undefined
          ? "No RouterService plugin could be selected unambiguously."
          : `Router service ${options.configured} is not installed.`,
      remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
    }),
  );
};
