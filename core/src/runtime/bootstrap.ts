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
 */
import { Schema } from "effect";

/**
 * BootstrapLevel.
 */
export const BootstrapLevel = Schema.Literal(
  "none",
  "minimal",
  "plugins",
  "commands",
  "tooling",
  "provider",
  "global",
  "scratch",
  "app",
);
export type BootstrapLevel = typeof BootstrapLevel.Type;

/**
 * Strict-ordering helper for level comparisons. Higher = more services
 * loaded. Note `tooling` is special: it's "commands + cache-only app plan",
 * so it's *higher* than `commands` but *lower* than `provider` for the
 * purposes of provider initialization.
 */
export const BOOTSTRAP_RANK: Record<BootstrapLevel, number> = {
  none: 0,
  minimal: 1,
  plugins: 2,
  commands: 3,
  tooling: 4,
  provider: 5,
  global: 6,
  scratch: 7,
  app: 8,
};

export const isAtLeast = (have: BootstrapLevel, need: BootstrapLevel): boolean =>
  BOOTSTRAP_RANK[have] >= BOOTSTRAP_RANK[need];
