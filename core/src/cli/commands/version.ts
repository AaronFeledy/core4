/**
 * `lando version` — print the Lando + plugin versions.
 *
 * Bootstrap level: `minimal`.
 *
 * Performance budget: `lando --version` must complete in < 80ms cold,
 * < 50ms hot.
 */
import { Effect, Schema } from "effect";

import { CORE_VERSION } from "../../version.ts";

export interface VersionResult {
  readonly core: string;
  readonly bun: string;
  readonly platform: NodeJS.Platform;
}

export const VersionResultSchema = Schema.Struct({
  core: Schema.String,
  bun: Schema.String,
  platform: Schema.String,
});

export const version: Effect.Effect<VersionResult, never, never> = Effect.sync(() => ({
  core: CORE_VERSION,
  bun: Bun.version,
  platform: process.platform,
}));
