/**
 * `HostProxyService` subsystem entry point.
 *
 * Core re-exports the `@lando/sdk` tag and provides a fail-closed fallback
 * `Layer` for environments where no `HostProxyService` plugin has been
 * installed yet. The default Live Layer (DNS sinkhole, `/etc/hosts` writer, or
 * Windows HOSTS writer per platform) ships from a downstream `lando setup`
 * step; until that step runs, `setup()`, `status()`, and `teardown()` fail
 * closed with an actionable `HostProxyError` message.
 *
 * `HostProxyService` behaviors:
 * - macOS Live Layer writes `/etc/resolver/<baseDomain>` (no `/etc/hosts` edit).
 * - Linux Live Layer writes a managed `/etc/hosts` block or a
 *   `systemd-resolved` drop-in.
 * - Windows Live Layer writes the HOSTS file under `System32\drivers\etc`.
 * - Privileged operations are gated behind sudo/UAC and ONLY run at
 *   `lando setup` time; `lando start` never triggers privilege prompts.
 * - `lando setup --host-proxy=none` records the opt-out for users managing
 *   their own DNS, which surfaces as `mode: "none"` + `mechanism: "skipped"`
 *   in `HostProxyStatus`.
 */
import { Effect, Layer } from "effect";

import { HostProxyError } from "@lando/sdk/errors";
import { HostProxyService } from "@lando/sdk/services";

export { HostProxyService };

const HOST_PROXY_UNAVAILABLE_ID = "unavailable" as const;
const HOST_PROXY_UNAVAILABLE_MESSAGE =
  "HostProxyService requires `lando setup` to install the host-proxy mechanism for this platform. Run `lando setup` (or `lando setup --host-proxy=none` to opt out).";

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
