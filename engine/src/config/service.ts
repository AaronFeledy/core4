/**
 * `ConfigService` Live Layer.
 *
 * The Live implementation:
 * 1. Loads `<userConfRoot>/config.yml` when it exists.
 * 2. Applies the currently supported `LANDO_*` env-var overrides inline.
 * 3. Merges in deterministic order (defaults → user config → env → inline).
 * 4. Validates the merged result against `GlobalConfig` schema.
 *
 * Status: stub.
 */
export { ConfigService } from "@lando/sdk/services";
