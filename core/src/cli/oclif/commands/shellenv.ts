/**
 * `lando shellenv` — print shell-profile snippets to add
 * `<userConfRoot>/bin` to PATH.
 *
 * **CLI-only** — not exported from `@lando/core/cli`.
 */
import { Command } from "@oclif/core";

export default class ShellenvCommand extends Command {
  static override description = "Print shell-profile snippets to integrate Lando into your PATH.";

  override async run(): Promise<void> {
    throw new Error("lando shellenv: not yet implemented");
  }
}
