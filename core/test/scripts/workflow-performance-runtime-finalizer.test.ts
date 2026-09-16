import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPerformanceProcess } from "../../../scripts/workflow-performance-processes.ts";
import { childEnv } from "../../src/cli/commands/bun-self-runner.ts";

test("stops a private namespace holder while retaining a missing-service failure", async () => {
  // Given a live private helper but no API service record.
  const root = await mkdtemp(join(tmpdir(), "perf-finalizer-"));
  const data = join(root, "data");
  const bin = join(data, "runtime/bin");
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "podman");
  await copyFile("/bin/bash", executable);
  const helper = Bun.spawn([executable], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const input = helper.stdin;
  const output = helper.stdout.getReader();
  input.write('printf "ready\\n"; read -r line\n');
  await input.flush();
  await output.read();
  try {
    const snapshot = await readPerformanceProcess(helper.pid);
    expect(snapshot?.executable).toBe(executable);
    // When production cleanup fails to read the missing service PID.
    const cleanup = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../../../scripts/workflow-performance-runtime-cleanup.ts")],
      {
        env: childEnv({ ...process.env, LANDO_USER_DATA_ROOT: data, XDG_RUNTIME_DIR: join(root, "run") }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit] = await Promise.all([
      cleanup.exited,
      new Response(cleanup.stdout).text(),
      new Response(cleanup.stderr).text(),
    ]);
    // Then failure remains nonzero but the owned helper has been finalized.
    expect(exit).not.toBe(0);
    expect(await readPerformanceProcess(helper.pid)).toBeUndefined();
  } finally {
    input.end();
    await helper.exited;
    output.releaseLock();
    await rm(root, { recursive: true, force: true });
  }
});
