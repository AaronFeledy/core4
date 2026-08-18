import { Effect, Schema } from "effect";
import { Flags } from "../../spec/metadata";

import { normalizeShellenvShell, renderShellenv } from "../../commands/shellenv";
import type { LandoCommandSpec } from "../../spec/command-base";

/**
 * `lando meta:shellenv` — print shell-profile snippets to add Lando to PATH.
 *
 * **CLI-only** — not exported from `@lando/core/cli`.
 */

export const shellenvShellFromInput = (input: unknown) => {
  if (typeof input !== "object" || input === null || !("flags" in input)) return "posix";
  const flags = (input as { readonly flags?: unknown }).flags;
  if (typeof flags !== "object" || flags === null || !("shell" in flags)) return "posix";
  const shell = (flags as { readonly shell?: unknown }).shell;
  return normalizeShellenvShell(typeof shell === "string" ? shell : undefined);
};

export const shellenvSpec: LandoCommandSpec<string> = {
  resultSchema: Schema.String,
  id: "meta:shellenv",
  summary: "Print shell-profile snippets to integrate Lando into your PATH.",
  description: "Print shell-profile snippets to integrate Lando into your PATH.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  flags: {
    shell: Flags.string({ options: ["posix", "powershell", "pwsh"], default: "posix" }),
  },
  run: (input) => Effect.succeed(renderShellenv(shellenvShellFromInput(input))),
  render: (result) => (typeof result === "string" ? result : undefined),
};
