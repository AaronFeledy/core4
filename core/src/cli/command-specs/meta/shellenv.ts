import { Effect, Schema } from "effect";
import { Flags } from "../../spec/metadata";

import { ShellenvInstallRecordError, normalizeShellenvShell, renderShellenv } from "../../commands/shellenv";
import type { LandoCommandSpec } from "../../spec/command-base";
import { specFlagsOf, stringFlag } from "../../spec/input-coercion";

/**
 * `lando meta:shellenv` — print shell-profile snippets to add Lando to PATH.
 *
 * **CLI-only** — not exported from `@lando/core/cli`.
 */

export const shellenvShellFromInput = (input: unknown) =>
  normalizeShellenvShell(stringFlag(specFlagsOf(input), "shell"));

export const shellenvSpec: LandoCommandSpec<string, ShellenvInstallRecordError, never> = {
  resultSchema: Schema.String,
  id: "meta:shellenv",
  summary: "Print shell-profile snippets to integrate Lando into your PATH.",
  description: "Print shell-profile snippets to integrate Lando into your PATH.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  flags: {
    shell: Flags.string({
      options: ["posix", "powershell", "pwsh"],
      description: "Defaults to PowerShell on Windows and POSIX on other platforms.",
    }),
  },
  run: (input) =>
    Effect.try({
      try: () => renderShellenv(shellenvShellFromInput(input)),
      catch: (error) => {
        if (error instanceof ShellenvInstallRecordError) return error;
        throw error;
      },
    }),
  render: (result) => (typeof result === "string" ? result : undefined),
};
