import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("runCli confines IO, status, cwd, environment, and provider state to its invocation context (#2113)", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-cli-context-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: invocation-app\nservices:\n  web:\n    type: nginx\n");
    const child = Bun.spawn(
      [process.execPath, new URL("./fixtures/run-cli-context.ts", import.meta.url).pathname, root],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const report = JSON.parse(stdout);
    expect(report.untouched).toBe(true);
    expect(report.observedDirectories.length).toBeGreaterThan(0);
    expect(new Set(report.observedDirectories)).toEqual(new Set([report.cwd]));
    expect(report.apps).toContain("invocation-app");
    expect(report.outputs.map((output: { statuses: number[] }) => output.statuses)).toEqual([
      [0],
      [0],
      [1],
      [0],
      [1],
    ]);
    expect(JSON.parse(report.outputs[0].stdout)).toMatchObject({ command: "meta:version", ok: true });
    expect(JSON.parse(report.outputs[1].stdout.trim().split("\n").at(-1))).toMatchObject({
      _tag: "result",
      envelope: { command: "app:start", ok: true },
    });
    expect(JSON.parse(report.outputs[2].stdout)).toMatchObject({ ok: false });
    expect(report.outputs[3].stdout).toBe(`${root}\ncontext-only\nhost input\n`);
    expect(report.outputs[4].stderr).toContain("ConfigError");
    expect(report.outputs[4].stderr).toContain(`${root}/host/cache`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
