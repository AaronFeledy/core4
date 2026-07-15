import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-config-translate-scenario-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

describe("lando app:config:translate CLI argv parsing", () => {
  test("rejects a bare --from with no value instead of silently autodetecting", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nruntime: 4\n");
      const result = await runCli(["app:config:translate", "--from"], dir);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--from has a malformed value.");
      expect(result.stderr).toContain("code: MalformedCliFlagValueError");
    });
  });

  test("rejects a bare --file with no value instead of silently running full-tree discovery", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nruntime: 4\n");
      const result = await runCli(["app:config:translate", "--file"], dir);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--file has a malformed value.");
      expect(result.stderr).toContain("code: MalformedCliFlagValueError");
    });
  });

  test("still accepts a valid --list --format=json invocation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:config:translate", "--list", "--format=json"], dir);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as { readonly ok?: boolean };
      expect(envelope.ok).toBe(true);
    });
  });
});
