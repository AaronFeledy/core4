/** Windows deferred binary replacement contracts and scheduling. */
import { copyFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { StateStore } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { Effect } from "effect";
import type { CoreReplacementPrecondition } from "./compatibility.ts";
import { type StoredUpdateResult, makeUpdateHandoff } from "./handoff.ts";
export { runWindowsReplacement, runWindowsReplacementProcess } from "./windows-helper.ts";

export interface UpdateWindowsReplacementInput {
  readonly executablePath: string;
  readonly installRecordFile: string;
  readonly stagedBinaryPath: string;
  readonly backupPath: string;
  readonly attemptedVersion: string;
  readonly manualFallback: string;
  readonly precondition?: CoreReplacementPrecondition;
  readonly completedResult?: StoredUpdateResult;
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

export const windowsManualFallback = ({
  backupPath,
  executablePath,
  stagedBinaryPath,
}: Pick<UpdateWindowsReplacementInput, "backupPath" | "executablePath" | "stagedBinaryPath">): string =>
  `Close every running Lando process, move ${executablePath} to ${backupPath}, then move ${stagedBinaryPath} to ${executablePath}. If replacement fails, move ${backupPath} back to ${executablePath}. If Windows requires elevation, open PowerShell as Administrator and run the same moves manually; Lando will not request UAC automatically.`;

export const windowsPermissionRemediation = (executablePath: string): string =>
  `Lando will not request UAC automatically. If this install path is correct, open PowerShell as Administrator and replace ${executablePath} manually with the downloaded Lando binary, or reinstall Lando into a user-writable directory.`;

export const buildWindowsReplacementScript = (
  input: UpdateWindowsReplacementInput,
  token: string,
): string => {
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    `"${windowsBatchValue(join(dirname(input.stagedBinaryPath), "lando-update-helper.exe"))}" --lando-update-replacement "${windowsBatchValue(join(dirname(input.stagedBinaryPath), "replacement.json"))}" "${windowsBatchValue(token)}"`,
    "if errorlevel 1 exit /b 1",
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
): Effect.Effect<void, unknown, StateStore> =>
  Effect.gen(function* () {
    if (input.precondition === undefined || input.completedResult === undefined)
      return yield* Effect.fail(
        new Error("Windows replacement requires a compatibility precondition and completed receipt."),
      );
    const handoff = makeUpdateHandoff(yield* StateStore);
    const token = yield* handoff.saveDeferred(input.completedResult);
    yield* Effect.tryPromise({
      try: async () => {
        const scriptPath = join(dirname(input.stagedBinaryPath), "replace-lando.cmd");
        await copyFile(
          input.executablePath,
          join(dirname(input.stagedBinaryPath), "lando-update-helper.exe"),
        );
        await writeFile(
          join(dirname(input.stagedBinaryPath), "replacement.json"),
          JSON.stringify({
            ...input,
            token,
            parentPid: process.pid,
          }),
          { mode: 0o600 },
        );
        await writeFile(scriptPath, buildWindowsReplacementScript(input, token));
        spawner({
          cmd: ["cmd.exe", "/d", "/s", "/c", scriptPath],
          cwd: dirname(input.stagedBinaryPath),
          detached: true,
        });
      },
      catch: (cause) => cause,
    }).pipe(Effect.tapError(() => handoff.consume(token)));
  });

export const defaultWindowsReplacement: UpdateWindowsReplacement = (input) =>
  scheduleWindowsReplacement(input).pipe(Effect.provide(StateStoreLive));
