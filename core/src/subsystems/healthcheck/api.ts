/**
 * `HealthcheckRunner` service interface.
 *
 * Healthcheck behaviors:
 * - Healthchecks support `false`/`disabled`, string, string-array, object,
 *   and `!load`/`!import` forms.
 * - Object form supports `command`, `user`, `retry`, `delay`, `timeout`.
 * - Startup distinguishes `running` from `ready`. The `ready` event fires
 *   when all healthchecks pass.
 * - The active `HealthcheckRunner` decides execution mechanics. The default
 *   provider-exec runner lives in `live.ts`, executes command healthchecks via
 *   `RuntimeProvider.exec`, builds retry/delay/timeout behavior on
 *   `@lando/sdk/probe`'s `runProbe`, and redacts probe failure details through
 *   `RedactionService` before surfacing them.
 * - This module keeps the explicit degraded-mode layer for contexts where no
 *   runtime provider is available.
 */
import { Effect, Layer } from "effect";

import { HealthcheckError } from "@lando/sdk/errors";
import { HealthcheckRunner } from "@lando/sdk/services";

export { HealthcheckRunner };

const HC_UNAVAILABLE_ID = "unavailable" as const;
const HC_UNAVAILABLE_MESSAGE =
  "HealthcheckRunner requires provider-exec. Run `lando setup` to install the provider (full implementation is not available yet).";

export const HealthcheckRunnerUnavailableLive = Layer.succeed(HealthcheckRunner, {
  id: HC_UNAVAILABLE_ID,
  run: (_plan, _appId, service) =>
    Effect.fail(new HealthcheckError({ message: HC_UNAVAILABLE_MESSAGE, service: String(service) })),
});
