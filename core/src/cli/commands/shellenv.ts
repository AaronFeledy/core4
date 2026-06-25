import { join } from "node:path";

import type { Context, Effect } from "effect";

import type { PrivilegeService, ProcessResult } from "@lando/sdk/services";

import { makeLandoPaths } from "../../config/paths.ts";
import { resolveUserDataRoot } from "../../config/roots.ts";

export type ShellenvShell = "posix" | "powershell";

const posixQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const powerShellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const normalizeShellenvShell = (value: string | undefined): ShellenvShell =>
  value === "powershell" || value === "pwsh" ? "powershell" : "posix";

export const shellenvBinDir = (userDataRoot = resolveUserDataRoot()): string =>
  makeLandoPaths({ userDataRoot }).binDir;

export const renderPosixShellenv = (userDataRoot = resolveUserDataRoot()): string =>
  `export LANDO_USER_DATA_ROOT=${posixQuote(userDataRoot)}\nexport PATH="\${LANDO_USER_DATA_ROOT}/bin:\${PATH}"`;

export const renderPowerShellShellenv = (userDataRoot = resolveUserDataRoot()): string =>
  `$Env:LANDO_USER_DATA_ROOT = ${powerShellQuote(userDataRoot)}\n$Env:PATH = "$($Env:LANDO_USER_DATA_ROOT)/bin$([System.IO.Path]::PathSeparator)$Env:PATH"`;

export const renderShellenv = (
  shell: ShellenvShell = "posix",
  userDataRoot = resolveUserDataRoot(),
): string =>
  shell === "powershell" ? renderPowerShellShellenv(userDataRoot) : renderPosixShellenv(userDataRoot);

const landoShellenvBlock = (userDataRoot: string): string =>
  ["# >>> LANDO shellenv >>>", renderPosixShellenv(userDataRoot), "# <<< LANDO shellenv <<<"].join("\n");

export const defaultPosixShellProfilePath = (env: NodeJS.ProcessEnv = process.env): string => {
  const home = env.HOME ?? ".";
  const shell = env.SHELL?.split(/[\\/]/u).at(-1) ?? "";
  if (shell === "zsh") return join(home, ".zshrc");
  if (shell === "bash") return join(home, ".bashrc");
  return join(home, ".profile");
};

export const shellProfileInstallCommand = (
  userDataRoot: string,
  profilePath = process.env.LANDO_SHELL_PROFILE ?? defaultPosixShellProfilePath(),
): ReadonlyArray<string> => {
  const block = landoShellenvBlock(userDataRoot);
  const script = [
    `profile=${posixQuote(profilePath)}`,
    `block=${posixQuote(block)}`,
    'mkdir -p "$(dirname "$profile")"',
    'touch "$profile"',
    'if ! grep -Fq "# >>> LANDO shellenv >>>" "$profile"; then',
    '  printf "\\n%s\\n" "$block" >> "$profile"',
    "fi",
  ].join("\n");
  return ["sh", "-c", script];
};

export const installShellProfileIntegration = (
  userDataRoot: string,
  privilege: Context.Tag.Service<typeof PrivilegeService>,
): Effect.Effect<ProcessResult, never> => privilege.elevate(shellProfileInstallCommand(userDataRoot));
