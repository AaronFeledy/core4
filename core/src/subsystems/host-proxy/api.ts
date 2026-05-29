import { Effect, Layer } from "effect";

import { HostProxyError } from "@lando/sdk/errors";
import { HostProxyService, type HostProxyServiceShape } from "@lando/sdk/services";

export { HostProxyService };

const HOST_PROXY_UNAVAILABLE_ID = "unavailable" as const;
const HOST_PROXY_UNAVAILABLE_MESSAGE =
  "HostProxyService requires `lando setup` to install the host-proxy mechanism for this platform. Run `lando setup` (or `lando setup --host-proxy=none` to opt out).";

const HOST_PROXY_DISABLED_ID = "disabled" as const;
const HOST_PROXY_DEFAULT_BASE_DOMAIN = "lndo.site";
const HOST_PROXY_DEFAULT_LOOPBACK = "127.0.0.1";

export const HostProxyServiceUnavailableLive = Layer.succeed(HostProxyService, {
  id: HOST_PROXY_UNAVAILABLE_ID,
  setup: (_options) =>
    Effect.fail(
      new HostProxyError({
        message: HOST_PROXY_UNAVAILABLE_MESSAGE,
        hostProxyId: HOST_PROXY_UNAVAILABLE_ID,
      }),
    ),
  status: () =>
    Effect.fail(
      new HostProxyError({
        message: HOST_PROXY_UNAVAILABLE_MESSAGE,
        hostProxyId: HOST_PROXY_UNAVAILABLE_ID,
      }),
    ),
  teardown: () =>
    Effect.fail(
      new HostProxyError({
        message: HOST_PROXY_UNAVAILABLE_MESSAGE,
        hostProxyId: HOST_PROXY_UNAVAILABLE_ID,
      }),
    ),
});

export const HostProxyServiceDisabled: HostProxyServiceShape = {
  id: HOST_PROXY_DISABLED_ID,
  setup: (_options) => Effect.void,
  status: () =>
    Effect.succeed({
      active: false,
      mode: "none" as const,
      mechanism: "skipped" as const,
      baseDomain: HOST_PROXY_DEFAULT_BASE_DOMAIN,
      loopback: HOST_PROXY_DEFAULT_LOOPBACK,
    }),
  teardown: () => Effect.void,
};

export const HostProxyServiceDisabledLive = Layer.succeed(HostProxyService, HostProxyServiceDisabled);
