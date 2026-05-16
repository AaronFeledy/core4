import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repoRoot, "core");
const binaryPath = resolve(coreRoot, "dist/lando");
const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET;
const canRunLiveSmoke = socketPath !== undefined && process.platform === "linux" && process.arch === "x64";

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (
  cmd: ReadonlyArray<string>,
  cwd: string,
  timeoutMs = 120_000,
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...(socketPath === undefined ? {} : { LANDO_TEST_PODMAN_SOCKET: socketPath }) },
  });

  const timeout = setTimeout(() => {
    proc.kill("SIGTERM");
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
};

const expectSuccess = (label: string, result: RunResult): void => {
  expect(result.stderr, `${label} stderr`).toBe("");
  expect(result.exitCode).toBe(0);
};

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-mvp-exit-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe.skipIf(!canRunLiveSmoke)("MVP exit-criteria smoke test", () => {
  test("reproduces the full init/start/info/stop flow with the compiled binary", async () => {
    await withTempDir(async (dir) => {
      const codegen = await runCommand([process.execPath, "run", "codegen"], repoRoot);
      // codegen may emit non-fatal OCLIF tsconfig-resolution warnings to stderr; only assert exit code
      expect(codegen.exitCode, "bun run codegen exit code").toBe(0);

      const build = await runCommand([process.execPath, "run", "build"], repoRoot, 180_000);
      expectSuccess("bun run build", build);

      const init = await runCommand([binaryPath, "init", "--full", "--name=mvp-exit"], dir);
      expectSuccess("lando init", init);
      expect(init.stdout).toContain("Created mvp-exit");
      const appDir = join(dir, "mvp-exit");

      // Capture stop result from the finally block so that assertions on it run
      // only when the try block itself succeeded — prevents a failing finally
      // block from masking the original start/info error.
      let stopResult: RunResult | undefined;
      try {
        const start = await runCommand([binaryPath, "start"], appDir, 180_000);
        expectSuccess("lando start", start);
        expect(start.stdout).toContain("ready: mvp-exit");
        expect(start.stdout).toContain("web");
        expect(start.stdout).toContain("database");

        const info = await runCommand([binaryPath, "info"], appDir);
        expectSuccess("lando info", info);
        expect(info.stdout).toContain("web\trunning");
        expect(info.stdout).toContain("database\trunning");
      } finally {
        // Best-effort cleanup — runCommand never throws, so this will not mask
        // any error that propagated out of the try block.
        stopResult = await runCommand([binaryPath, "stop"], appDir, 180_000);
      }
      // Only assert stop results when the try block (start/info) succeeded.
      // stopResult is always set by the finally block (runCommand never throws),
      // but the guard satisfies the type checker without a non-null assertion.
      if (stopResult !== undefined) {
        expectSuccess("lando stop", stopResult);
        expect(stopResult.stdout).toContain("stopped: mvp-exit");
      }
    });
  }, 300_000);
});
