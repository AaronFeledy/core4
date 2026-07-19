/**
 * `meta:setup` flag definitions and provider-scoped plugin flag selection.
 *
 * Built-in flags are declared here; provider-specific flags (e.g. Lando runtime
 * bundle overrides) are contributed by plugins through `setup.flags` and merged
 * via the generated contribution table rather than hardcoded. Reserved names
 * (the built-ins plus the universal `--format`/`--json`) cannot be shadowed by a
 * plugin. `contributedSetupFlagsForProvider` reads the values a plugin declared
 * for the active provider off the parsed input.
 */
import { Flags } from "@oclif/core";

import { BUNDLED_SETUP_FLAG_CONTRIBUTIONS } from "../../generated/setup-plugin-flags.ts";
import { mergeSetupPluginFlags } from "../../setup-plugin-flags-merge.ts";
import { contributedSetupInputFlags } from "./setup-inputs.ts";

export const SETUP_BUILTIN_FLAGS = {
  yes: Flags.boolean({ description: "Skip confirmation prompts.", default: false }),
  "no-interactive": Flags.boolean({
    description: "Do not prompt; fail or use documented non-interactive setup defaults.",
    default: false,
  }),
  provider: Flags.string({
    description: "Choose a provider (e.g. lando, docker, podman). Overrides Landofile/env/config selection.",
  }),
  "skip-provider": Flags.boolean({ default: false }),
  "skip-proxy": Flags.boolean({ default: false }),
  "skip-install-ca": Flags.boolean({ default: false }),
  "skip-shell-integration": Flags.boolean({ default: false }),
  "skip-file-sync": Flags.boolean({
    description: "Skip Mutagen binary download; deferred to first accelerated app:start.",
    default: false,
  }),
  "host-proxy": Flags.string({
    description:
      "Configure the host-proxy DNS mechanism. `auto` (default) selects the per-platform default; `none` opts out for users managing their own DNS.",
    options: ["auto", "none"],
    default: "auto",
  }),
} as const;

// Universal output flags (`--format`/`--json`) come from the base command; reserve
// their names so a plugin cannot silently shadow them.
const SETUP_RESERVED_FLAG_NAMES = [...Object.keys(SETUP_BUILTIN_FLAGS), "format", "json"];

export const SETUP_PLUGIN_FLAGS = mergeSetupPluginFlags(
  SETUP_RESERVED_FLAG_NAMES,
  BUNDLED_SETUP_FLAG_CONTRIBUTIONS,
);

const contributedSetupFlagNamesForProvider = (providerId: string): ReadonlyArray<string> =>
  BUNDLED_SETUP_FLAG_CONTRIBUTIONS.filter((contribution) => contribution.providers.includes(providerId)).map(
    (contribution) => contribution.flag.name,
  );

export const contributedSetupFlagsForProvider = (
  input: unknown,
  providerId: string,
): Record<string, unknown> => {
  const flags = contributedSetupInputFlags(input);
  const result: Record<string, unknown> = {};
  if (flags === undefined) return result;
  for (const name of contributedSetupFlagNamesForProvider(providerId)) {
    const value = flags[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
};
