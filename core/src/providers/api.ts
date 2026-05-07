/**
 * `RuntimeProvider` Effect service interface.
 *
 * Re-exports the canonical `RuntimeProvider` tag from `@lando/sdk/services`
 * so plugin authors can import it from a single, documented location:
 * `@lando/core/services` (which re-exports from here).
 *
 * The full method surface — `apply`, `start`, `stop`, `restart`, `destroy`,
 * `exec`, `run`, `logs`, `inspect`, `list`, `buildArtifact`, `pullArtifact`,
 * `removeArtifact`, `setup`, `getStatus`, `getVersions`, `isAvailable`, plus
 * capability + identity fields — lands in `@lando/sdk/services` as the
 * planner stabilizes.
 */
export { RuntimeProvider, type RuntimeProviderShape } from "@lando/sdk/services";
