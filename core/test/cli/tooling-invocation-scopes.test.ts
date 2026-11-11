import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const invoke = async (declaration: string, args: readonly string[]) => {
  const root = await mkdtemp(join(tmpdir(), "lando-input-scopes-"));
  try {
    const env = {
      ...process.env,
      DO_NOT_TRACK: "1",
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_SYSTEM_PLUGIN_ROOT: join(root, "plugins"),
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
      `name: scopes\ntooling:\n  inspect:\n    service: ':host'\n${declaration}\n`,
    );
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../../bin/lando.ts"), ...args, "--format=json"],
      { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode, envelope: JSON.parse(stdout) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("source CLI binds input and forwards only the unconsumed verbose flag", async () => {
  const value = "safe; echo INJECTED";
  const result = await invoke(
    "    flags:\n      name:\n        required: true\n      verbose:\n        boolean: true\n    cmd: bun -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- {{ flags.name }}",
    ["inspect", `--name=${value}`, "--verbose=true"],
  );
  expect(result.exitCode).toBe(0);
  expect(result.envelope).toMatchObject({
    ok: true,
    result: { stdout: `${JSON.stringify([value, "--verbose"])}\n` },
  });
});

test("source CLI exposes all four task identity fields as values", async () => {
  const result = await invoke(
    '    cmd: echo "{{ task.name }}|{{ task.subnamespace }}|{{ task.commandNamespace }}|{{ task.canonicalId }}"',
    ["inspect"],
  );
  expect(result.exitCode).toBe(0);
  expect(result.envelope).toMatchObject({ ok: true, result: { stdout: "inspect||app|app:inspect\n" } });
});

test.each(["service", "sources", "generates", "checksum", "timestamp"])(
  "source CLI names remaining %s scope during load",
  async (scope) => {
    const result = await invoke(`    cmd: echo {{ ${scope}.value }}`, ["inspect"]);
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: {
        _tag: "NotImplementedError",
        message: expect.stringContaining(`scope ${scope}`),
        remediation: expect.stringContaining("tooling.inspect.cmd"),
      },
    });
  },
);
