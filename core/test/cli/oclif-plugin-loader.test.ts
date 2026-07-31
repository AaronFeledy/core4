import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const sourceCli = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, sourceCli, ...args],
    cwd: repoRoot,
    env,
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

describe("OCLIF user plugin loading", () => {
  let root = "";
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-oclif-data-root-"));
    const unusableDataHome = join(root, "data-file");
    await writeFile(unusableDataHome, "not a directory");
    env = {
      ...process.env,
      HOME: join(root, "home"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: unusableDataHome,
      LANDO_DOCTOR_SECTION_BUDGET_MS: "100",
    };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("config does not emit a loader stack when XDG_DATA_HOME is a file", async () => {
    const result = await runCli(["meta:config", "--format", "json"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("loadUserPlugins");
    expect(result.stderr).not.toContain("ENOTDIR");
  });

  test("doctor remains self-resilient without loader stderr noise", async () => {
    const result = await runCli(["doctor", "--format", "ndjson"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"_tag":"result"');
    expect(result.stderr).not.toContain("loadUserPlugins");
    expect(result.stderr).not.toContain("ENOTDIR");
  });
});
