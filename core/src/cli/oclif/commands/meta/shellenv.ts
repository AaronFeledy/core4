/**
 * `lando meta:shellenv` — print shell-profile snippets to add Lando to PATH.
 *
 * **CLI-only** — not exported from `@lando/core/cli`.
 */
import { Flags } from "@oclif/core";
import { Effect } from "effect";

import { normalizeShellenvShell, renderShellenv } from "../../../commands/shellenv.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

const inputShell = (input: unknown) => {
  if (typeof input !== "object" || input === null || !("flags" in input)) return "posix";
  const flags = (input as { readonly flags?: unknown }).flags;
  if (typeof flags !== "object" || flags === null || !("shell" in flags)) return "posix";
  const shell = (flags as { readonly shell?: unknown }).shell;
  return normalizeShellenvShell(typeof shell === "string" ? shell : undefined);
};

export const shellenvSpec: LandoCommandSpec<string> = {
  id: "meta:shellenv",
  summary: "Print shell-profile snippets to integrate Lando into your PATH.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  run: (input) => Effect.succeed(renderShellenv(inputShell(input))),
  render: (result) => (typeof result === "string" ? result : undefined),
};

export default class ShellenvCommand extends LandoCommandBase {
  static override description = shellenvSpec.summary;
  static override aliases = [...resolveTopLevelAliases(shellenvSpec)];
  static override flags = {
    shell: Flags.string({ options: ["posix", "powershell", "pwsh"], default: "posix" }),
  };
  static override landoSpec: LandoCommandSpec = shellenvSpec;
  static override bootstrap = shellenvSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(shellenvSpec);
  }
}
