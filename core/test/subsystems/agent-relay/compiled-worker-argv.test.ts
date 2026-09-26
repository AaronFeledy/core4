import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_RELAY_WORKER_COMMAND } from "@lando/engine/subsystems/ssh-agent/worker-protocol";
import { cliUserArgv } from "../../../src/cli/user-argv";
import { ensureCompiledCli } from "../../_support/compiled-cli";

test("agent relay argv preserves the internal command in source and compiled launches", () => {
  // Given the detached worker's command tail.
  const tail = [AGENT_RELAY_WORKER_COMMAND, "--app-id", "compiled-smoke"];
  // When Bun uses each supported entry convention.
  const results = [
    cliUserArgv(["/bin/lando", ...tail]),
    cliUserArgv(["/bin/bun", "/repo/core/bin/lando.ts", ...tail]),
    cliUserArgv(["/bin/lando", "/$bunfs/root/lando", ...tail]),
    cliUserArgv(["C:\\lando.exe", "B:\\~BUN\\root\\lando", ...tail]),
  ];
  // Then dispatch receives exactly the worker command and app marker.
  for (const result of results) expect(result).toEqual(tail);
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("compiled agent relay worker", () => {
  test("waits for stdin then rejects invalid input rather than routing to an unknown command", async () => {
    // Given the shipping binary outside the repository.
    const binary = await ensureCompiledCli();
    const root = await mkdtemp(join(tmpdir(), "lando-compiled-agent-"));
    const proc = Bun.spawn([binary, AGENT_RELAY_WORKER_COMMAND, "--app-id", "compiled-smoke"], {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        LANDO_USER_DATA_ROOT: root,
        LANDO_USER_CONF_ROOT: root,
        LANDO_USER_CACHE_ROOT: root,
      },
    });
    try {
      // When the parent closes invalid worker input.
      await Bun.sleep(400);
      expect(proc.exitCode).toBeNull();
      await proc.stdin.end();
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      // Then worker validation exits nonzero without publishing readiness.
      expect(exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).not.toMatch(/unknown command/i);
      expect(stderr.length).toBeGreaterThan(0);
    } finally {
      proc.kill();
      await proc.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
