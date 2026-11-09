import { expect, test } from "bun:test";
import { constants, closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const fixture = join(import.meta.dir, "fixtures/stdio-file-status.ts");
const nonblock = process.platform === "darwin" ? 0x4 : 0o4000;

const withFifo = async (
  run: (fifo: {
    readonly write: number;
    readonly flags: () => number;
    readonly dir: string;
  }) => Promise<void>,
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "lando-stdio-flags-"));
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
        try {
          await run({ write, flags: () => oracle.symbols.fcntl(write, 3, 0), dir });
        } finally {
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

for (const [scenario, expectedBit, exitCode] of [
  ["control", nonblock, 0],
  ["natural", 0, 0],
  ["explicit-exit", 0, 3],
  ["initially-nonblocking", nonblock, 0],
  ["reconcile", 0, 0],
] as const) {
  test.skipIf(process.platform === "win32")(`stdio flags survive ${scenario} (#1466)`, async () => {
    // Given a parent-retained FIFO writer with O_APPEND, independent of the child.
    await withFifo(async ({ write, flags }) => {
      // When Bun mutates the inherited open file description and the child exits.
      const child = Bun.spawn({
        cmd: [process.execPath, fixture, scenario],
        cwd: root,
        stdin: "ignore",
        stdout: write,
        stderr: write,
      });
      const code = await child.exited;
      // Then only O_NONBLOCK is reconciled. The control proves this Bun still leaks the bit;
      // if it starts passing after a Bun upgrade, the restore may no longer be needed.
      const current = flags();
      expect(code).toBe(exitCode);
      expect(current).toBeGreaterThanOrEqual(0);
      expect(current & nonblock).toBe(expectedBit);
      expect(current & constants.O_APPEND).toBe(constants.O_APPEND);
    });
  });
}

test.skipIf(process.platform === "win32")(
  "compiled entry restores flags outside checkout (#1466)",
  async () => {
    // Given a standalone bytecode executable and a parent-owned FIFO.
    await withFifo(async ({ write, flags, dir }) => {
      const outfile = join(dir, "stdio-fixture");
      const build = await Bun.build({
        entrypoints: [fixture],
        target: "bun",
        format: "esm",
        bytecode: true,
        compile: { outfile },
      });
      if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"));
      // When the executable runs from outside the repository.
      const child = Bun.spawn({ cmd: [outfile], cwd: dir, stdin: "ignore", stdout: write, stderr: write });
      const code = await child.exited;
      // Then pre-JS initialization has not prevented restoring the inherited state.
      const current = flags();
      expect(code).toBe(0);
      expect(current).toBeGreaterThanOrEqual(0);
      expect(current & nonblock).toBe(0);
      expect(current & constants.O_APPEND).toBe(constants.O_APPEND);
    });
  },
  30_000,
);
