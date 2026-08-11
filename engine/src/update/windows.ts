/** Windows deferred binary replacement contracts and scheduling. */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect } from "effect";

export interface UpdateWindowsReplacementInput {
  readonly executablePath: string;
  readonly stagedBinaryPath: string;
  readonly backupPath: string;
  readonly attemptedVersion: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly manualFallback: string;
}

export type UpdateWindowsReplacement = (
  input: UpdateWindowsReplacementInput,
) => Effect.Effect<void, unknown, never>;

export interface UpdateWindowsReplacementSpawnInput {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd: string;
  readonly detached: boolean;
}

export type UpdateWindowsReplacementSpawner = (input: UpdateWindowsReplacementSpawnInput) => void;

const windowsBatchValue = (value: string): string => value.replaceAll("%", "%%").replaceAll('"', '""');

const windowsCommandArg = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;

export const windowsManualFallback = ({
  backupPath,
  executablePath,
  stagedBinaryPath,
}: Pick<UpdateWindowsReplacementInput, "backupPath" | "executablePath" | "stagedBinaryPath">): string =>
  `Close every running Lando process, move ${executablePath} to ${backupPath}, then move ${stagedBinaryPath} to ${executablePath}. If replacement fails, move ${backupPath} back to ${executablePath}. If Windows requires elevation, open PowerShell as Administrator and run the same moves manually; Lando will not request UAC automatically.`;

export const windowsPermissionRemediation = (executablePath: string): string =>
  `Lando will not request UAC automatically. If this install path is correct, open PowerShell as Administrator and replace ${executablePath} manually with the downloaded Lando binary, or reinstall Lando into a user-writable directory.`;

export const buildWindowsReplacementScript = (input: UpdateWindowsReplacementInput): string => {
  const restartArgs = input.argv.slice(1).map(windowsCommandArg).join(" ");
  return [
    "@echo off",
    "setlocal",
    `set "TARGET=${windowsBatchValue(input.executablePath)}"`,
    `set "CANDIDATE=${windowsBatchValue(input.stagedBinaryPath)}"`,
    `set "BACKUP=${windowsBatchValue(input.backupPath)}"`,
    ":wait",
    'move /Y "%TARGET%" "%BACKUP%" >nul 2>nul',
    "if not errorlevel 1 goto install",
    "timeout /t 1 /nobreak >nul 2>nul",
    "goto wait",
    ":install",
    'move /Y "%CANDIDATE%" "%TARGET%" >nul 2>nul',
    "if errorlevel 1 (",
    '  move /Y "%BACKUP%" "%TARGET%" >nul 2>nul',
    "  exit /b 1",
    ")",
    `start "" "%TARGET%"${restartArgs.length === 0 ? "" : ` ${restartArgs}`}`,
    'rmdir /S /Q "%~dp0" >nul 2>nul',
    "endlocal",
  ].join("\r\n");
};

const defaultWindowsReplacementSpawner: UpdateWindowsReplacementSpawner = (input) => {
  const proc = Bun.spawn([...input.cmd], {
    cwd: input.cwd,
    stdout: "ignore",
    stderr: "ignore",
    detached: input.detached,
  });
  const detachable = proc as { readonly unref?: () => void };
  detachable.unref?.();
};

export const scheduleWindowsReplacement = (
  input: UpdateWindowsReplacementInput,
  spawner: UpdateWindowsReplacementSpawner = defaultWindowsReplacementSpawner,
): Effect.Effect<void, unknown, never> =>
  Effect.tryPromise({
    try: async () => {
      const scriptPath = join(dirname(input.stagedBinaryPath), "replace-lando.cmd");
      await writeFile(scriptPath, buildWindowsReplacementScript(input));
      spawner({
        cmd: ["cmd.exe", "/d", "/s", "/c", scriptPath],
        cwd: dirname(input.stagedBinaryPath),
        detached: true,
      });
    },
    catch: (cause) => cause,
  });

export const defaultWindowsReplacement: UpdateWindowsReplacement = (input) =>
  scheduleWindowsReplacement(input);
