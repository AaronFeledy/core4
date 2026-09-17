import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { AGENT_SKILLS_SKILL_ID, AGENT_SKILLS_SKILL_PATH } from "../../src/agent-skills/pack.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-agent-skills-cli-")));
  const previousCwd = process.cwd();
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "lando-data");
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    env: { ...process.env, LANDO_USER_DATA_ROOT: join(cwd, "lando-data") },
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

const writeApp = async (dir: string): Promise<void> => {
  await writeFile(join(dir, ".lando.yml"), "name: agent-skills-cli\nservices: {}\n", "utf8");
};

describe("lando agent:skills CLI", () => {
  test("install, update, and remove own only Lando-managed files", async () => {
    await withTempCwd(async (dir) => {
      await writeApp(dir);
      await writeFile(join(dir, "NOTES.md"), "keep me\n", "utf8");
      await writeFile(join(dir, "AGENTS.md"), "# Project notes\nuser owned\n", "utf8");

      const installed = await runCli(["agent:skills", "install", "--format=json"], dir);
      expect(installed.exitCode).toBe(0);
      const installResult = JSON.parse(installed.stdout) as {
        readonly ok: boolean;
        readonly result: {
          readonly verb: string;
          readonly entries: ReadonlyArray<{ readonly action: string; readonly path: string }>;
        };
      };
      expect(installResult.ok).toBe(true);
      expect(installResult.result.verb).toBe("install");
      expect(installResult.result.entries).toEqual([
        { action: "create", path: AGENT_SKILLS_SKILL_PATH, id: AGENT_SKILLS_SKILL_ID },
      ]);

      const skill = await Bun.file(join(dir, AGENT_SKILLS_SKILL_PATH)).text();
      expect(skill).toContain(`lando-generated:${AGENT_SKILLS_SKILL_ID}`);
      expect(skill).toContain("lando exec");
      expect(skill).toContain("lando mcp");
      expect(await Bun.file(join(dir, "NOTES.md")).text()).toBe("keep me\n");
      expect(await Bun.file(join(dir, "AGENTS.md")).text()).toBe("# Project notes\nuser owned\n");

      const updated = await runCli(["agent:skills:update", "--format=json"], dir);
      expect(updated.exitCode).toBe(0);
      const updateResult = JSON.parse(updated.stdout) as {
        readonly result: { readonly entries: ReadonlyArray<{ readonly action: string }> };
      };
      expect(updateResult.result.entries.every((entry) => entry.action === "skip-unchanged")).toBe(true);

      const removed = await runCli(["app:agent:skills:remove", "--format=json"], dir);
      expect(removed.exitCode).toBe(0);
      expect(await Bun.file(join(dir, AGENT_SKILLS_SKILL_PATH)).exists()).toBe(false);
      expect(await Bun.file(join(dir, "NOTES.md")).text()).toBe("keep me\n");
      expect(await Bun.file(join(dir, "AGENTS.md")).text()).toBe("# Project notes\nuser owned\n");
    });
  });

  test("init does not write skills unless --agent-skills is passed", async () => {
    await withTempCwd(async (dir) => {
      const off = await runCli(
        ["init", "--name=skills-off", "--recipe=toolbox", "--yes", "--no-interactive"],
        dir,
      );
      expect(off.exitCode).toBe(0);
      expect(off.stdout).toContain("Created skills-off at");
      expect(await Bun.file(join(dir, "skills-off", AGENT_SKILLS_SKILL_PATH)).exists()).toBe(false);

      const on = await runCli(
        ["init", "--name=skills-on", "--recipe=toolbox", "--yes", "--no-interactive", "--agent-skills"],
        dir,
      );
      expect(on.exitCode).toBe(0);
      expect(on.stdout).toContain("Created skills-on at");
      expect(on.stdout).toContain("Installed agent skills");
      const skill = await Bun.file(join(dir, "skills-on", AGENT_SKILLS_SKILL_PATH)).text();
      expect(skill).toContain("lando-generated:");
      expect(skill).toContain("Do not invent a host package manager");
    });
  });

  test("install requires an app", async () => {
    await withTempCwd(async (dir) => {
      await mkdir(join(dir, "empty"), { recursive: true });
      const result = await runCli(["agent:skills:install", "--format=json"], join(dir, "empty"));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("LandofileNotFoundError");
    });
  });
});
