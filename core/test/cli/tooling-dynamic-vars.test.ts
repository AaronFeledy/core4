import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("source CLI reports dynamic var failure as status 1 with the child status in its error", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-cli-dynamic-var-"));
  try {
    const env = {
      ...process.env,
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_SYSTEM_PLUGIN_ROOT: join(root, "plugins"),
      DO_NOT_TRACK: "1",
    };
    for (const path of [
      env.LANDO_USER_CONF_ROOT,
      env.LANDO_USER_CACHE_ROOT,
      env.LANDO_USER_DATA_ROOT,
      env.LANDO_SYSTEM_PLUGIN_ROOT,
    ])
      await mkdir(path);
    await Bun.write(
      join(root, ".lando.yml"),
      "name: dynamic-cli\ntooling:\n  showvar:\n    service: ':host'\n    cmd: echo BODY-MARKER\n    vars:\n      X:\n        sh: exit 3\n",
    );
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../../bin/lando.ts"), "showvar", "--format=json"],
      { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      error: { _tag: "ToolingExecError", tool: "showvar", variable: "X", exitCode: 3 },
    });
    expect(stdout + stderr).not.toContain("BODY-MARKER");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
