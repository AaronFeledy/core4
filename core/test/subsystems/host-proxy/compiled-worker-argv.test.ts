import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureCompiledCli } from "../../_support/compiled-cli.ts";

const HOST_PROXY_WORKER_COMMAND = "__internal:host-proxy-worker";

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "compiled host-proxy worker argv",
  () => {
    test("compiled __internal:host-proxy-worker stays up until stdin is closed", async () => {
      const binary = await ensureCompiledCli();
      const root = await mkdtemp(join(tmpdir(), "lando-compiled-host-proxy-"));
      try {
        const proc = Bun.spawn([binary, HOST_PROXY_WORKER_COMMAND, "--app-id", "compiled-smoke"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          cwd: root,
        });
        await Bun.sleep(400);
        const earlyExit = proc.exitCode;
        expect(earlyExit).toBeNull();
        proc.stdin.end();
        const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        expect(exitCode).not.toBe(0);
        expect(stderr).not.toMatch(/unknown command/i);
        expect(stderr.length).toBeGreaterThan(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
