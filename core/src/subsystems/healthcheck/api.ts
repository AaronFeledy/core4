/**
 * `HealthcheckRunner` service interface.
 *
 * Healthcheck behaviors:
 * - Healthchecks support `false`/`disabled`, string, string-array, object,
 *   and `!load`/`!import` forms.
 * - Object form supports `command`, `user`, `retry`, `delay`, `timeout`.
 * - Startup distinguishes `running` from `ready`. The `ready` event fires
 *   when all healthchecks pass.
 * - The active `HealthcheckRunner` decides execution mechanics. Default:
 *   `RuntimeProvider.exec` with retry/delay loop. The full provider-exec
 *   runner is not implemented yet; when it lands, its retry/delay/timeout
 *   loop and `ready` verdict must build on `@lando/sdk/probe`'s `runProbe`
 *   rather than a hand-rolled `Effect.retry`/`Schedule` loop (enforced by the
 *   probe boundary gate), and must redact `ProbeResult.lastError` before it
 *   reaches an event or transcript.
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
