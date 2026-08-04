/**
 * Source roots of every first-party workspace package, grouped by the coverage
 * tier a boundary rule needs. Adding a workspace package MUST extend these
 * lists; `core/test/scripts/boundary/workspace-roots.test.ts` fails when a
 * package in the root `workspaces` array has a `src/` tree that no tier
 * covers.
 */

/**
 * Rules policing runtime behaviour in shipped code: core, the `@lando/paths`
 * and `@lando/state-store` primitive packages, and every plugin.
 */
export const CORE_AND_PLUGIN_SOURCE_ROOTS = ["core/src", "paths/src", "state-store/src", "plugins"] as const;

/**
 * Rules that must see every first-party package's own source tree (glob
 * form, `plugins/*\/src` expands per plugin).
 */
export const ALL_PACKAGE_SOURCE_ROOTS = [
  "container-runtime/src",
  "core/src",
  "paths/src",
  "sdk/src",
  "state-store/src",
  "plugins/*/src",
] as const;

/**
 * Plain-directory form for the two gates (`check-telemetry-inventory.ts`,
 * `check-deprecations.ts`) that predate the boundary substrate and walk
 * directories without glob expansion. Deliberately omits
 * `container-runtime/src`: neither gate has ever covered it, and extending
 * coverage here would silently broaden both gates.
 */
export const ALL_PACKAGE_WALK_ROOTS = [
  "core/src",
  "paths/src",
  "sdk/src",
  "state-store/src",
  "plugins",
] as const;

/**
 * First-party, non-plugin packages — the set a plugin package must never be
 * imported back into. This is the all-package tier without its plugin glob.
 */
export const NON_PLUGIN_SOURCE_ROOTS = [
  "container-runtime/src",
  "core/src",
  "paths/src",
  "sdk/src",
  "state-store/src",
] as const;
