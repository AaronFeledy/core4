import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_SKILLS_SKILL_PATH } from "@lando/engine/operations/agent-skills";

const cliEntry = resolve(import.meta.dirname, "../../bin/lando.ts");

test("removes owned skills from the canonical cwd after init through a symlinked parent", async () => {
  // Given an isolated home and a real parent-directory alias.
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-skills-alias-")));
  const parent = join(root, "parent");
  const alias = join(root, "alias");
  await mkdir(parent);
  await symlink(parent, alias, "dir");
  const app = join(parent, "app");
  const run = async (args: readonly string[], cwd: string) => {
    const proc = Bun.spawn({
      cmd: [process.execPath, cliEntry, ...args],
      cwd,
      env: {
        ...process.env,
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CONF_ROOT: join(root, "config"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_SYSTEM_PLUGIN_ROOT: join(root, "plugins"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    return stdout;
  };
  try {
    await run(
      [
        "init",
        join(alias, "app"),
        "--name=app",
        "--recipe=toolbox",
        "--yes",
        "--no-interactive",
        "--agent-skills",
      ],
      root,
    );

    // When a later command discovers the same app from its canonical cwd.
    const output = await run(["agent:skills:remove", "--format=json"], app);

    // Then removal finds the ownership recorded by init and deletes the skill.
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      result: { appRoot: app, entries: [{ path: AGENT_SKILLS_SKILL_PATH, action: "update" }] },
    });
    expect(await Bun.file(join(app, AGENT_SKILLS_SKILL_PATH)).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
