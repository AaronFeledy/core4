import { expect } from "bun:test";
import { constants, closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nonblock = process.platform === "darwin" ? 0x4 : 0o4000;

interface FifoChildOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Runs `cmd` with stdout and stderr on one FIFO open file description that the
 * test keeps, then asserts the child left `O_NONBLOCK` clear on it (#1466).
 * The check uses its own 3-argument F_GETFL, independent of the code under test.
 */
export const withFifoChild = async (
  cmd: string[],
  options: FifoChildOptions,
  run: (child: Bun.Subprocess, read: number) => Promise<void>,
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "lando-cli-stdio-"));
  try {
    expect(Bun.spawnSync(["mkfifo", join(dir, "pipe")]).exitCode).toBe(0);
    const read = openSync(join(dir, "pipe"), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const write = openSync(join(dir, "pipe"), constants.O_WRONLY | constants.O_APPEND);
      try {
        const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
        const oracle = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
          fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
        });
        const child = Bun.spawn({
          cmd,
          cwd: options.cwd,
          ...(options.env === undefined ? {} : { env: options.env }),
          stdin: "ignore",
          stdout: write,
          stderr: write,
        });
        const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
        try {
          await run(child, read);
          const current = oracle.symbols.fcntl(write, 3, 0);
          expect(current).toBeGreaterThanOrEqual(0);
          expect(current & nonblock).toBe(0);
          expect(current & constants.O_APPEND).toBe(constants.O_APPEND);
        } finally {
          clearTimeout(deadline);
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await child.exited;
          oracle.close();
        }
      } finally {
        closeSync(write);
      }
      readFileSync(read);
    } finally {
      closeSync(read);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
