/**
 * `lando meta:setup` — provider, CA, proxy, and shell-integration setup.
 *
 * Bootstrap: `provider`.
 * **Interactive only** — not exported as a function from `@lando/core/cli`;
 * embedding hosts construct equivalent flows from `@lando/core/services`
 * and `PrivilegeService`.
 */
import { Flags } from "@oclif/core";
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const setupSpec: LandoCommandSpec<never> = {
  id: "meta:setup",
  summary: "Run host setup (provider, CA, proxy, shell integration).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "provider",
  run: () => Effect.die("not yet implemented: meta:setup"),
};

export default class SetupCommand extends LandoCommandBase {
  static override description = "Run provider, CA, proxy, and shell-integration setup.";
  static override aliases = [...resolveTopLevelAliases(setupSpec)];
  static override flags = {
    yes: Flags.boolean({ description: "Skip confirmation prompts.", default: false }),
    provider: Flags.string({ description: "Choose a provider (e.g. docker, podman)." }),
    "skip-provider": Flags.boolean({ default: false }),
    "skip-proxy": Flags.boolean({ default: false }),
    "skip-install-ca": Flags.boolean({ default: false }),
    "skip-shell-integration": Flags.boolean({ default: false }),
  };
  static override landoSpec: LandoCommandSpec = setupSpec;

  override async run(): Promise<void> {
    await this.runEffect(setupSpec);
  }
}
