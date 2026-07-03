/**
 * Merge plugin-contributed `setup.flags` into the `meta:setup` flag surface.
 *
 * This is a pure module: it converts each `PluginSetupFlagContribution` to an
 * OCLIF flag and rejects any name that collides with a built-in setup flag or
 * with another plugin's contribution. Collisions surface as the tagged
 * `SetupFlagCollisionError` so the failure is machine-readable rather than a
 * silent last-writer-wins overwrite.
 */
import { Flags, type Interfaces } from "@oclif/core";

import type { PluginSetupFlagContribution } from "@lando/sdk/schema";

import { SetupFlagCollisionError, findSetupFlagCollision } from "../../plugins/setup-flags.ts";
import type { BundledSetupFlagContribution } from "./generated/setup-plugin-flags.ts";

export { SetupFlagCollisionError };

type OclifSetupFlag =
  | Interfaces.BooleanFlag<string | boolean | undefined>
  | Interfaces.OptionFlag<string | undefined>;

export interface MergedSetupFlags {
  /** Contributed flags keyed by flag name, ready to spread into command flags. */
  readonly flags: Record<string, OclifSetupFlag>;
  /** Flag name → contributing plugin package. */
  readonly ownership: ReadonlyMap<string, string>;
}

const pluginSetupFlagToOclif = (flag: PluginSetupFlagContribution): OclifSetupFlag => {
  if (flag.type === "boolean") {
    return Flags.boolean({
      ...(flag.description === undefined ? {} : { description: flag.description }),
      default: false,
    });
  }
  return Flags.string({
    ...(flag.description === undefined ? {} : { description: flag.description }),
    ...(flag.options === undefined ? {} : { options: [...flag.options] }),
  });
};

/**
 * Merge plugin setup-flag contributions on top of the built-in flag names.
 *
 * @throws {SetupFlagCollisionError} when a contributed flag name collides with a
 * built-in flag or with an earlier plugin contribution.
 */
export const mergeSetupPluginFlags = (
  builtInFlagNames: Iterable<string>,
  contributions: ReadonlyArray<BundledSetupFlagContribution>,
): MergedSetupFlags => {
  const collision = findSetupFlagCollision(
    builtInFlagNames,
    contributions.map(({ plugin, flag }) => ({ plugin, flagName: flag.name })),
  );
  if (collision !== undefined) throw collision;

  const flags: Record<string, OclifSetupFlag> = {};
  const ownership = new Map<string, string>();
  for (const { plugin, flag } of contributions) {
    flags[flag.name] = pluginSetupFlagToOclif(flag);
    ownership.set(flag.name, plugin);
  }

  return { flags, ownership };
};
