import { expect, test } from "bun:test";
import { readSync } from "node:fs";
import { join, resolve } from "node:path";
import { withFifoChild } from "./stdio-file-status-support.ts";

const root = resolve(import.meta.dir, "../../..");
const entry = join(root, "core/bin/lando.ts");

for (const argv of [["--version"], ["version", "--format=json"]]) {
  test.skipIf(process.platform === "win32")(
    `real CLI restores stdio for ${argv.join(" ")} (#1466)`,
    async () => {
      // Given a FIFO open file description retained by the parent.
      await withFifoChild([process.execPath, entry, ...argv], { cwd: root }, async (child, read) => {
        // When the real CLI completes a cold or full-dispatch command.
        const code = await child.exited;
        const output = Buffer.alloc(8192);
        // Then the command succeeds with output, and the independent oracle checks its flags.
        expect(code).toBe(0);
        expect(readSync(read, output)).toBeGreaterThan(0);
      });
    },
    15_000,
  );
}

test.skipIf(process.platform === "win32")(
  "managed SIGTERM restores stdio before re-raise (#1466)",
  async () => {
    // Given an active signal owner that has dirtied its inherited stdout.
    const fixture = join(import.meta.dir, "fixtures/stdio-file-status-signal.ts");
    await withFifoChild([process.execPath, fixture], { cwd: root }, async (child, read) => {
      const buffer = Buffer.alloc(64);
      let output = "";
      const deadline = performance.now() + 5000;
      while (!output.includes("ready\n")) {
        if (performance.now() >= deadline || child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Signal fixture did not become ready: ${output}`);
        }
        try {
          output += buffer.subarray(0, readSync(read, buffer)).toString();
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EAGAIN") throw error;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // When SIGTERM interrupts the work and cleanup settles.
      child.kill("SIGTERM");
      await child.exited;
      // Then the original signal kills the process, and the parent oracle checks restored flags.
      expect(child.signalCode).toBe("SIGTERM");
    });
  },
  15_000,
);
