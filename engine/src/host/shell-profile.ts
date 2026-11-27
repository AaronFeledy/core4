/**
 * The user's POSIX shell profile and the `LANDO4 shellenv` block Lando keeps in it.
 *
 * Setup adds the block and uninstall strips it, both as the invoking user. Lando never elevates
 * these writes: a profile the user cannot write is reported, never taken over.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { FileSystem } from "@lando/sdk/services";
import { Effect } from "effect";

export const LANDO_SHELLENV_BEGIN = "# >>> LANDO4 shellenv >>>";
export const LANDO_SHELLENV_END = "# <<< LANDO4 shellenv <<<";

/** `LANDO_SHELL_PROFILE`, else the profile of the user's `$SHELL`, else `~/.profile`. */
export const defaultPosixShellProfilePath = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env.LANDO_SHELL_PROFILE;
  if (override !== undefined && override !== "") return override;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const shell = env.SHELL?.split(/[\\/]/u).at(-1) ?? "";
  if (shell === "zsh") return join(home, ".zshrc");
  if (shell === "bash") return join(home, ".bashrc");
  return join(home, ".profile");
};

/** Wraps rendered shellenv lines in the markers uninstall recognizes. */
export const landoShellenvBlock = (body: string): string =>
  [LANDO_SHELLENV_BEGIN, body, LANDO_SHELLENV_END].join("\n");

export const stripLandoShellenvBlock = (
  content: string,
): { readonly content: string; readonly stripped: boolean } => {
  let result = content;
  let stripped = false;
  while (true) {
    const begin = result.indexOf(LANDO_SHELLENV_BEGIN);
    if (begin === -1) break;
    const end = result.indexOf(LANDO_SHELLENV_END, begin + LANDO_SHELLENV_BEGIN.length);
    if (end === -1) break;
    let cutEnd = end + LANDO_SHELLENV_END.length;
    if (result.startsWith("\r\n", cutEnd)) cutEnd += 2;
    else if (result.startsWith("\n", cutEnd)) cutEnd += 1;
    result = `${result.slice(0, begin)}${result.slice(cutEnd)}`;
    stripped = true;
  }
  return { content: result, stripped };
};

/**
 * Appends `block` to the profile unless a `LANDO4 shellenv` block is already there. Missing
 * parent directories and the file are created as the invoking user; the append uses `O_APPEND`
 * so concurrent edits by the user are never overwritten.
 */
export const installShellProfileBlock = Effect.fn("ShellProfile.install")(function* (
  profilePath: string,
  block: string,
) {
  const fs = yield* FileSystem;
  if (yield* fs.exists(profilePath)) {
    if ((yield* fs.readText(profilePath)).includes(LANDO_SHELLENV_BEGIN)) return "present" as const;
  } else {
    yield* fs.mkdir(dirname(profilePath));
  }
  yield* fs.append(profilePath, `\n${block}\n`);
  return "appended" as const;
});
