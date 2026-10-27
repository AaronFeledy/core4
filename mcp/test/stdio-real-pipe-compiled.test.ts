import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadline, fixturePath } from "./fixtures/real-pipe-client";
import { abandonment } from "./fixtures/real-pipe-scenarios";

const skipCompile = process.env.LANDO_SKIP_COMPILE_SMOKE === "1";
let directory: string | undefined;
let binary: string | undefined;

if (!skipCompile) {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "lando-mcp-real-pipe-"));
    binary = join(directory, process.platform === "win32" ? "mcp-fixture.exe" : "mcp-fixture");
    const compile = Bun.spawn([process.execPath, "build", "--compile", fixturePath, "--outfile", binary], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await deadline(
        Promise.all([
          compile.exited,
          new Response(compile.stdout).text(),
          new Response(compile.stderr).text(),
        ]),
        "compile real-pipe fixture",
        60_000,
      );
      expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
    } finally {
      if (compile.exitCode === null) compile.kill("SIGKILL");
      await deadline(compile.exited, "compiler reap");
    }
  }, 70_000);
}

afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

for (const scenario of [
  { kind: "tool", shutdown: "EOF" },
  { kind: "resource", shutdown: "SIGTERM" },
] as const) {
  test.skipIf(skipCompile || (process.platform === "win32" && scenario.shutdown === "SIGTERM"))(
    `compiled real stdio ${scenario.kind} cleanup on ${scenario.shutdown} outside the repo`,
    async () => {
      // Given the same fixture compiled once, relocated to a unique temporary directory.
      if (binary === undefined || directory === undefined) throw new Error("Fixture compilation did not run");
      // When it handles abandonment, then the real-pipe contract remains identical to source mode.
      await abandonment([binary], directory, scenario);
    },
    20_000,
  );
}
