/**
 * `lando setup` — provider, CA, proxy, and shell-integration setup.
 *
 * Bootstrap: `plugins` (then loads provider/CA/proxy as needed).
 * **Interactive only** — not exported as a function from `@lando/core/cli`;
 * embedding hosts construct equivalent flows from `@lando/core/services`
 * and `PrivilegeService`.
 */
import { Command, Flags } from "@oclif/core";

export default class SetupCommand extends Command {
  static override description = "Run provider, CA, proxy, and shell-integration setup.";
  static override flags = {
    yes: Flags.boolean({ description: "Skip confirmation prompts.", default: false }),
    provider: Flags.string({ description: "Choose a provider (e.g. docker, podman)." }),
    "skip-provider": Flags.boolean({ default: false }),
    "skip-proxy": Flags.boolean({ default: false }),
    "skip-install-ca": Flags.boolean({ default: false }),
    "skip-shell-integration": Flags.boolean({ default: false }),
  };

  override async run(): Promise<void> {
    throw new Error("lando setup: not yet implemented");
  }
}
