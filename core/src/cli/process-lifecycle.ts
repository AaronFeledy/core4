/**
 * The CLI process's single exit owner. Every path that ends the process without
 * firing 'exit' must go through here; inherited stdio flags must be restored first.
 */
let installation: Promise<void> | undefined;
let restoreStdioFlags: (() => void) | undefined;

export const installProcessLifecycle = (): Promise<void> => {
  installation ??= (async () => {
    const { preserveStdioFileStatusFlags, restoreStdioFileStatusFlags } = await import(
      "@lando/renderer/stdio-flags"
    );
    preserveStdioFileStatusFlags();
    restoreStdioFlags = restoreStdioFileStatusFlags;
    const { installBrokenPipeExitPolicy } = await import("@lando/renderer/native-stdio");
    installBrokenPipeExitPolicy();
  })();
  return installation;
};

export const reraiseSignal = (signal: NodeJS.Signals): void => {
  restoreStdioFlags?.();
  process.kill(process.pid, signal);
};

export const execProcess = (input: {
  readonly path: string;
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string>;
}): void => {
  restoreStdioFlags?.();
  if (process.execve === undefined) throw new Error("process.execve is not available in this runtime");
  process.execve(input.path, input.argv, input.env);
};
