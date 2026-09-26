// Default host adapter for the Podman machine SSH bridge: resolves binaries and runs the long-lived
// reverse-forwarding ssh process.
export class BridgeCommandError extends Error {}

export interface MachineSshBridgeProcess {
  readonly waitReady: () => Promise<void>;
  readonly close: () => Promise<void>;
}
export interface MachineSshBridgeHost {
  readonly which: (name: string) => string | undefined;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  readonly start: (command: string, args: ReadonlyArray<string>) => MachineSshBridgeProcess;
}

export const defaultHost: Omit<MachineSshBridgeHost, "run"> = {
  which: (name) => Bun.which(name) ?? undefined,
  start: (command, args) => {
    const child = Bun.spawn([command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    let stderr = "";
    let closePromise: Promise<void> | undefined;
    const drain = (async () => {
      for await (const chunk of child.stderr)
        stderr = (stderr + new TextDecoder().decode(chunk)).slice(-4096);
    })();
    return {
      waitReady: async () => {
        const reader = child.stdout.getReader();
        const timeout = setTimeout(() => child.kill(), 15_000);
        try {
          let output = "";
          while (output.length < 1024) {
            const next = await reader.read();
            if (next.done)
              throw new BridgeCommandError(`SSH reverse forwarding exited before readiness: ${stderr}`);
            output += new TextDecoder().decode(next.value);
            if (output.includes("LANDO_BRIDGE_READY\n")) return;
          }
          throw new BridgeCommandError("SSH reverse forwarding did not report readiness.");
        } finally {
          clearTimeout(timeout);
          reader.releaseLock();
        }
      },
      close: () => {
        closePromise ??= (async () => {
          child.stdin.end();
          const timeout = setTimeout(() => child.kill(), 3_000);
          try {
            await Promise.all([child.exited, drain]);
          } finally {
            clearTimeout(timeout);
          }
        })();
        return closePromise;
      },
    };
  },
};
