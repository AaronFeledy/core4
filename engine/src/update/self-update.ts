/** Self-update process contracts and binary staging primitives. */
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { Effect } from "effect";

import { UpdatePermissionError } from "./errors.ts";
import { type UpdateWindowsReplacement, defaultWindowsReplacement } from "./windows.ts";

export interface UpdateExecveInput {
  readonly path: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
}

export type UpdateExecve = (input: UpdateExecveInput) => Effect.Effect<void, unknown, never>;
export type UpdateRename = (from: string, to: string) => Promise<void>;

export interface UpdateSelfUpdateOptions {
  readonly executablePath?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly argv?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly execve?: UpdateExecve;
  readonly rename?: UpdateRename;
  readonly replaceWindows?: UpdateWindowsReplacement;
}

export const stringEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

interface ExecveProcess {
  readonly execve?: (path: string, argv: ReadonlyArray<string>, env: Record<string, string>) => never;
}

const defaultExecve: UpdateExecve = (input) =>
  Effect.try({
    try: () => {
      const execve = (process as ExecveProcess).execve;
      if (execve === undefined) throw new Error("process.execve is not available in this runtime");
      execve(input.path, input.argv, input.env);
    },
    catch: (cause) => cause,
  });

const isLikelyLandoExecutable = (path: string): boolean => basename(path).startsWith("lando");

const defaultSelfUpdateExecutablePath = (): string | undefined =>
  isLikelyLandoExecutable(process.execPath) ? process.execPath : undefined;

export const posixPermissionRemediation = (executablePath: string): string =>
  `Lando will not run sudo automatically. Fix write permissions for ${dirname(executablePath)}, reinstall Lando into a user-writable directory, or download the matching Lando binary from GitHub Releases and run: sudo install -m 755 <downloaded-lando-binary> ${executablePath}`;

const permissionErrorCodes = new Set(["EACCES", "EPERM"]);

const errorCodeFrom = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

export const isPermissionCause = (cause: unknown): boolean => {
  const code = errorCodeFrom(cause);
  return code !== undefined && permissionErrorCodes.has(code);
};

export interface ResolvedSelfUpdateOptions {
  readonly executablePath: string;
  readonly platform: string;
  readonly arch: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execve: UpdateExecve;
  readonly rename: UpdateRename;
  readonly replaceWindows: UpdateWindowsReplacement;
}

export const resolveSelfUpdateOptions = (
  input: false | UpdateSelfUpdateOptions | undefined,
): ResolvedSelfUpdateOptions | undefined => {
  if (input === false) return undefined;
  const executablePath = input?.executablePath ?? defaultSelfUpdateExecutablePath();
  if (executablePath === undefined) return undefined;
  return {
    executablePath,
    platform: input?.platform ?? process.platform,
    arch: input?.arch ?? process.arch,
    // Engine owns no process-entry facts (engine-closure): the CLI shell supplies
    // the invocation argv; absent that, re-exec falls back to the bare executable.
    argv: input?.argv ?? [executablePath],
    env: input?.env ?? process.env,
    execve: input?.execve ?? defaultExecve,
    rename: input?.rename ?? rename,
    replaceWindows: input?.replaceWindows ?? defaultWindowsReplacement,
  };
};

export const writeDownloadedBinary = (
  path: string,
  bytes: Uint8Array,
  permissionPath = path,
  remediation = posixPermissionRemediation(permissionPath),
): Effect.Effect<void, UpdatePermissionError> =>
  Effect.tryPromise({
    try: async () => {
      await writeFile(path, bytes);
      await chmod(path, 0o755);
    },
    catch: (cause) =>
      new UpdatePermissionError({
        message: `Failed to write executable update artifact at ${path}.`,
        path: permissionPath,
        remediation,
        cause,
      }),
  });

export const renameForUpdate = (
  renamePath: UpdateRename,
  from: string,
  to: string,
  permissionPath = to,
): Effect.Effect<void, UpdatePermissionError> =>
  Effect.tryPromise({
    try: () => renamePath(from, to),
    catch: (cause) =>
      new UpdatePermissionError({
        message: `Failed to rename ${from} to ${to}.`,
        path: permissionPath,
        remediation: posixPermissionRemediation(permissionPath),
        cause,
      }),
  });

export const cleanupUpdateTempDir = (tempDir: string): Effect.Effect<void> =>
  Effect.promise(() => rm(tempDir, { recursive: true, force: true })).pipe(
    Effect.catchAll(() => Effect.void),
  );

export const reexecUserArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const userArgv = argv.slice(1);
  return userArgv[0]?.startsWith("/$bunfs/") === true ? userArgv.slice(1) : userArgv;
};
