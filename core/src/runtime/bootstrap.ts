/**
 * Bootstrap level orchestration.
 *
 * Each command declares the `BootstrapLevel` it needs. The OCLIF init hook
 * (`src/cli/oclif/hooks/init.ts`) reads that level off the resolved command,
 * builds the `LandoRuntimeLive` Layer at exactly that depth, and then runs
 * the command's Effect program against it.
 *
 * Levels strictly extend each other: every higher level includes everything
 * the lower levels load. The `tooling` level is the hot path — it combines
 * `commands` with a cache-only read of the app plan, deliberately deferring
 * provider initialization until the command actually executes.
 *
 * `BootstrapLevel` and `BOOTSTRAP_RANK` are owned by `@lando/sdk/schema`
 * (semver-stable contract). Core re-exports them so internal call sites
 * keep their existing import path.
 */
export { BOOTSTRAP_RANK, BootstrapLevel } from "@lando/sdk/schema";

import { BOOTSTRAP_RANK, type BootstrapLevel } from "@lando/sdk/schema";

export const isAtLeast = (have: BootstrapLevel, need: BootstrapLevel): boolean =>
  BOOTSTRAP_RANK[have] >= BOOTSTRAP_RANK[need];
