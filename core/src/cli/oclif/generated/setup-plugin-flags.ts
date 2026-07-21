/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-setup-plugin-flags.ts`.
 *
 * Source of truth: bundled plugins' `contributes.setup.flags` (the ship list in
 * `core/build.config.ts`).
 *
 * This is deliberately a literal-data module with no plugin or Effect imports,
 * so the `meta:setup` command can merge these contributions into its flag
 * surface without pulling the bundled plugin Layers into the compiled CLI
 * command graph (a cold-start regression).
 */

import type { PluginSetupFlagContribution } from "@lando/sdk/schema";

export interface BundledSetupFlagContribution {
  /** Bundled plugin package that contributes the flag. */
  readonly plugin: string;
  /** Provider ids the contributing plugin registers. */
  readonly providers: ReadonlyArray<string>;
  /** The contributed setup flag. */
  readonly flag: PluginSetupFlagContribution;
}

export const BUNDLED_SETUP_FLAG_CONTRIBUTIONS: ReadonlyArray<BundledSetupFlagContribution> = [
  {
    plugin: "@lando/provider-lando",
    providers: ["lando"],
    flag: {
      name: "enable-linger",
      type: "boolean",
      description: "Enable systemd user lingering as an optional persistence convenience.",
    },
  },
  {
    plugin: "@lando/provider-lando",
    providers: ["lando"],
    flag: {
      name: "runtime-bundle-url",
      type: "option",
      description: "Override the Lando-managed runtime bundle URL for setup.",
    },
  },
  {
    plugin: "@lando/provider-lando",
    providers: ["lando"],
    flag: {
      name: "runtime-bundle-sha256",
      type: "option",
      description: "Pinned SHA-256 paired with --runtime-bundle-url for verifying a local bundle.",
    },
  },
];
