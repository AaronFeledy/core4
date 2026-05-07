/**
 * `AppPlanner` Live Layer.
 *
 * The planner:
 *   1. Discovers + parses + merges the Landofile (`LandofileService`).
 *   2. Expands recipes via the recipe registry.
 *   3. Resolves `type: <name>` per-service via `ServiceType` plugins.
 *   4. Composes service features in priority order.
 *   5. Validates the final `AppPlan` against the `AppPlan` schema.
 *   6. Caches the encoded plan to `<userCacheRoot>/apps/<app-id>/plan.bin`.
 *
 * Status: stub.
 */
export { AppPlanner } from "@lando/sdk/services";
