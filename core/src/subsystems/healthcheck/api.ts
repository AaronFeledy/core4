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
 *   `RuntimeProvider.exec` with retry/delay loop.
 */
export { HealthcheckRunner } from "@lando/sdk/services";
