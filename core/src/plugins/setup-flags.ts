/**
 * Shared authority for plugin-contributed `setup.flags` collisions.
 *
 * Both the `meta:setup` command (which merges bundled contributions into its
 * flag surface) and the bootstrap manifest pass (which validates every
 * discovered plugin at load) use this so a colliding flag name always surfaces
 * the same tagged error instead of a silent last-writer-wins overwrite.
 */
import { Schema } from "effect";

import type { PluginManifest } from "@lando/sdk/schema";

export class SetupFlagCollisionError extends Schema.TaggedError<SetupFlagCollisionError>()(
  "SetupFlagCollisionError",
  {
    pluginName: Schema.String,
    flagName: Schema.String,
    conflictsWith: Schema.String,
    remediation: Schema.String,
  },
) {}

export const SETUP_BUILTIN_FLAG_NAMES: ReadonlyArray<string> = [
  "yes",
  "no-interactive",
  "provider",
  "skip-provider",
  "skip-proxy",
  "skip-install-ca",
  "skip-shell-integration",
  "skip-file-sync",
  "host-proxy",
  "format",
  "json",
];

export interface SetupFlagContributionRef {
  readonly plugin: string;
  readonly flagName: string;
}

export const findSetupFlagCollision = (
  builtInFlagNames: Iterable<string>,
  contributions: ReadonlyArray<SetupFlagContributionRef>,
): SetupFlagCollisionError | undefined => {
  const builtIns = new Set(builtInFlagNames);
  const owners = new Map<string, string>();
  for (const { plugin, flagName } of contributions) {
    if (builtIns.has(flagName)) {
      return new SetupFlagCollisionError({
        pluginName: plugin,
        flagName,
        conflictsWith: "built-in",
        remediation: `Rename the "${flagName}" flag contributed by ${plugin}; it collides with a built-in \`lando setup\` flag.`,
      });
    }
    const prior = owners.get(flagName);
    if (prior !== undefined) {
      return new SetupFlagCollisionError({
        pluginName: plugin,
        flagName,
        conflictsWith: prior,
        remediation: `Rename the "${flagName}" flag contributed by ${plugin}; it collides with the flag already contributed by ${prior}.`,
      });
    }
    owners.set(flagName, plugin);
  }
  return undefined;
};

export const manifestSetupFlagContributions = (
  manifests: ReadonlyArray<PluginManifest>,
): ReadonlyArray<SetupFlagContributionRef> => {
  const contributions: SetupFlagContributionRef[] = [];
  for (const manifest of manifests) {
    for (const flag of manifest.contributes?.setup?.flags ?? []) {
      contributions.push({ plugin: String(manifest.name), flagName: flag.name });
    }
  }
  return contributions;
};
