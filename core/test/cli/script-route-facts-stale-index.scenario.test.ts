import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    env: { ...process.env, LANDO_PROVIDER: "lando" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { exitCode, stdout };
};

const script = (env: boolean) =>
  [
    "# ---",
    "# desc: Smoke",
    ...(env ? ["# env:", '#   SITE_URL: "{{ services.web.url }}"'] : []),
    "# ---",
    'printf "[%s]\\n" "$SITE_URL"',
    "",
  ].join("\n");

const withApp = async <T>(run: (root: string, scriptPath: string) => Promise<T>): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-script-stale-")));
  const scriptPath = join(root, ".lando/scripts/smoke.bun.sh");
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: script-stale\nservices:\n  web:\n    type: nginx\n");
    await writeFile(scriptPath, script(false));
    return await run(root, scriptPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("an env edit to an indexed script rebuilds the entry and refuses before start", async () => {
  await withApp(async (root, scriptPath) => {
    // Given the script is indexed without env and already ran on the minimal path
    expect(await runCli(["smoke", "--format=json"], root)).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"stdout":"[]\\n"'),
    });
    // When env is added and the script runs before any explicit refresh
    await writeFile(scriptPath, script(true));
    const result = await runCli(["smoke", "--format=json"], root);
    // Then the recompiled entry routes through the app tier and locates the refusal
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        _tag: "ToolingCompileError",
        issues: [
          {
            reason: "app-not-started",
            path: ["env", "SITE_URL"],
            source: { layer: "script", file: scriptPath, path: ["env", "SITE_URL"] },
          },
        ],
      },
    });
  });
});

test("removing env from an indexed script returns it to the minimal path", async () => {
  await withApp(async (root, scriptPath) => {
    // Given the script reads a route fact and its index entry needs the app tier
    await writeFile(scriptPath, script(true));
    expect((await runCli(["smoke", "--format=json"], root)).exitCode).toBe(1);
    // When env is removed and the script runs before any explicit refresh
    await writeFile(scriptPath, script(false));
    // Then the recompiled entry drops the app tier without an error
    expect(await runCli(["smoke", "--format=json"], root)).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"stdout":"[]\\n"'),
    });
  });
});
