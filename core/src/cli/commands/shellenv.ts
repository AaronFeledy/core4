import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Context, Effect } from "effect";

import type { PrivilegeService, ProcessResult } from "@lando/sdk/services";

import { makeLandoPaths, resolveLandoRoots } from "@lando/paths";

export type ShellenvShell = "posix" | "powershell";

export const defaultShellenvShell = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellenvShell => {
  if (platform !== "win32") return "posix";
  if (/^(?:MINGW(?:32|64)|UCRT64|CLANG64|MSYS)$/u.test(env.MSYSTEM ?? "")) return "posix";
  const shell = env.SHELL?.split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/u, "");
  return shell === "sh" || shell === "bash" || shell === "zsh" ? "posix" : "powershell";
};

const posixQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const powerShellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const normalizeShellenvShell = (value: string | undefined): ShellenvShell => {
  switch (value) {
    case "powershell":
    case "pwsh":
      return "powershell";
    case "posix":
      return "posix";
    default:
      return defaultShellenvShell();
  }
};

// Cold-path counterpart of the engine schema/error; parity is pinned in shellenv.test.ts.
export class ShellenvInstallRecordError extends Error {
  readonly _tag = "InstallRecordError";
  readonly remediation =
    "Check the install record and executable permissions; rerun the Lando 4 installer to repair the record. Do not adopt an unrecognized executable.";

  constructor(
    readonly reason: "invalid-json" | "schema" | "unsupported-version" | "not-regular-file" | "io",
    readonly file: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = this._tag;
    this.message = `${detail} ${this.remediation}`;
  }
}

const objectValue = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const sha256Value = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const parseExecutable = (json: string, file: string) => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ShellenvInstallRecordError("invalid-json", file, "Install record is not valid JSON.");
  }
  if (objectValue(value) && "version" in value && value.version !== 1) {
    throw new ShellenvInstallRecordError(
      "unsupported-version",
      file,
      "Only install record version 1 is supported.",
    );
  }
  const data = objectValue(value) ? value.data : undefined;
  const executable = objectValue(data) ? data.executable : undefined;
  if (
    !objectValue(value) ||
    value.version !== 1 ||
    !onlyKeys(value, ["version", "data"]) ||
    !objectValue(data) ||
    !onlyKeys(data, ["executable", "shellProfiles"]) ||
    !Array.isArray(data.shellProfiles) ||
    !data.shellProfiles.every(
      (profile: unknown) =>
        objectValue(profile) &&
        onlyKeys(profile, ["path", "blockSha256"]) &&
        typeof profile.path === "string" &&
        sha256Value(profile.blockSha256),
    ) ||
    !objectValue(executable) ||
    !onlyKeys(executable, ["path", "sha256", "size", "channel", "platform", "releaseVersion"]) ||
    typeof executable.path !== "string" ||
    !sha256Value(executable.sha256) ||
    typeof executable.size !== "number" ||
    !Number.isInteger(executable.size) ||
    executable.size < 0 ||
    typeof executable.channel !== "string" ||
    typeof executable.platform !== "string" ||
    ("releaseVersion" in executable && typeof executable.releaseVersion !== "string")
  ) {
    throw new ShellenvInstallRecordError(
      "schema",
      file,
      "Install record does not match the version 1 schema.",
    );
  }
  return { path: executable.path, sha256: executable.sha256, size: executable.size };
};

export const shellenvBinDir = (userDataRoot = resolveLandoRoots().userDataRoot): string => {
  const paths = makeLandoPaths({ userDataRoot });
  const file = paths.installRecordFile;
  try {
    const recordStat = lstatSync(file, { throwIfNoEntry: false });
    if (recordStat === undefined) return paths.binDir;
    if (!recordStat.isFile() || recordStat.isSymbolicLink() || recordStat.isDirectory()) {
      throw new ShellenvInstallRecordError(
        "not-regular-file",
        file,
        "Install record must be a regular file.",
      );
    }
    const executable = parseExecutable(readFileSync(file, "utf8"), file);
    const target = executable.path;
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.isDirectory()) {
      throw new ShellenvInstallRecordError(
        "not-regular-file",
        file,
        "Executable ownership failed: not-regular-file.",
      );
    }
    const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
    if (digest !== executable.sha256) {
      throw new ShellenvInstallRecordError("schema", file, "Executable ownership failed: digest-mismatch.");
    }
    if (stat.size !== executable.size) {
      throw new ShellenvInstallRecordError("schema", file, "Executable ownership failed: size-mismatch.");
    }
    return dirname(executable.path);
  } catch (error) {
    if (error instanceof ShellenvInstallRecordError) throw error;
    if (!(error instanceof Error)) throw error;
    throw new ShellenvInstallRecordError("io", file, "Cannot read install record or installed executable.");
  }
};

export const renderPosixShellenv = (userDataRoot = resolveLandoRoots().userDataRoot): string => {
  const binDir = shellenvBinDir(userDataRoot);
  return `export LANDO_USER_DATA_ROOT=${posixQuote(userDataRoot)}\ncase ":\${PATH}:" in *${posixQuote(`:${binDir}:`)}*) ;; *) export PATH=${posixQuote(binDir)}":\${PATH}" ;; esac`;
};

export const renderPowerShellShellenv = (userDataRoot = resolveLandoRoots().userDataRoot): string => {
  const binDir = powerShellQuote(shellenvBinDir(userDataRoot));
  return `$Env:LANDO_USER_DATA_ROOT = ${powerShellQuote(userDataRoot)}\nif (-not (($Env:PATH -split [IO.Path]::PathSeparator) -contains ${binDir})) { $Env:PATH = ${binDir} + [IO.Path]::PathSeparator + $Env:PATH }`;
};

export const renderShellenv = (
  shell: ShellenvShell = defaultShellenvShell(),
  userDataRoot = resolveLandoRoots().userDataRoot,
): string =>
  shell === "powershell" ? renderPowerShellShellenv(userDataRoot) : renderPosixShellenv(userDataRoot);

const landoShellenvBlock = (userDataRoot: string): string =>
  ["# >>> LANDO4 shellenv >>>", renderPosixShellenv(userDataRoot), "# <<< LANDO4 shellenv <<<"].join("\n");

export const defaultPosixShellProfilePath = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env.LANDO_SHELL_PROFILE;
  if (override !== undefined && override !== "") return override;
  const home = env.HOME ?? ".";
  const shell = env.SHELL?.split(/[\\/]/u).at(-1) ?? "";
  if (shell === "zsh") return join(home, ".zshrc");
  if (shell === "bash") return join(home, ".bashrc");
  return join(home, ".profile");
};

export const shellProfileInstallCommand = (
  userDataRoot: string,
  profilePath = defaultPosixShellProfilePath(),
): ReadonlyArray<string> => {
  const block = landoShellenvBlock(userDataRoot);
  const script = [
    `profile=${posixQuote(profilePath)}`,
    `block=${posixQuote(block)}`,
    'mkdir -p "$(dirname "$profile")"',
    'touch "$profile"',
    'if ! grep -Fq "# >>> LANDO4 shellenv >>>" "$profile"; then',
    '  printf "\\n%s\\n" "$block" >> "$profile"',
    "fi",
  ].join("\n");
  return ["sh", "-c", script];
};

export const installShellProfileIntegration = (
  userDataRoot: string,
  privilege: Context.Tag.Service<typeof PrivilegeService>,
): Effect.Effect<ProcessResult, never> => privilege.elevate(shellProfileInstallCommand(userDataRoot));
