import { Effect } from "effect";

import type { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { DEFAULT_PROXY_DOMAIN } from "../planner/naming.ts";

/**
 * Resolve the configured ingress proxy default domain, falling back to
 * {@link DEFAULT_PROXY_DOMAIN} when `proxy.defaultDomain` is unset.
 */
export const readProxyDefaultDomain = (
  config: Readonly<{ readonly proxy?: GlobalConfig["proxy"] }>,
): string => config.proxy?.defaultDomain ?? DEFAULT_PROXY_DOMAIN;

/**
 * Read `proxy.defaultDomain` from optional `ConfigService`, falling back to
 * {@link DEFAULT_PROXY_DOMAIN} when the service is absent or load fails.
 */
export const resolveProxyDefaultDomain: Effect.Effect<string> = Effect.gen(function* () {
  const configOpt = yield* Effect.serviceOption(ConfigService);
  if (configOpt._tag === "None") return DEFAULT_PROXY_DOMAIN;
  return yield* configOpt.value.load.pipe(
    Effect.map(readProxyDefaultDomain),
    Effect.catchAll(() => Effect.succeed(DEFAULT_PROXY_DOMAIN)),
  );
});
