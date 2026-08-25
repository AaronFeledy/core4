import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtureEntry = resolve(import.meta.dirname, "fixtures/jq-wasm-compile-entry.ts");

describe("jq-wasm compiled binary embedding", () => {
  test("bun build --compile evals .a on {a:1} and prints 1", async () => {
    if (process.env.LANDO_SKIP_COMPILE_SMOKE !== undefined && process.env.LANDO_SKIP_COMPILE_SMOKE !== "") {
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), "lando-jq-wasm-compile-"));
    const outfile = join(workDir, "jq-smoke");
    try {
      const build = Bun.spawn({
        cmd: [process.execPath, "build", "--compile", fixtureEntry, "--outfile", outfile],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [buildCode, buildStdout, buildStderr] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ]);
      expect(buildCode, `compile failed:\n${buildStdout}\n${buildStderr}`).toBe(0);

      const run = Bun.spawn({
        cmd: [outfile],
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [runCode, runStdout, runStderr] = await Promise.all([
        run.exited,
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
      ]);
      expect(runCode, `compiled fixture failed:\n${runStdout}\n${runStderr}`).toBe(0);
      expect(runStdout.trim()).toBe("1");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 180_000);
});
