/**
 * `ConfigService` Live Layer.
 *
 * The Live implementation:
 * 1. Loads `<userConfRoot>/config.yml` and `config.d/*.yml` overlays.
 * 2. Decodes `LANDO_*` env-var overrides via `./env.ts`.
 * 3. Merges in deterministic order (defaults → user config → env → inline).
 * 4. Validates the merged result against `GlobalConfig` schema.
 *
 * Status: stub.
 */
export { ConfigService } from "@lando/sdk/services";
