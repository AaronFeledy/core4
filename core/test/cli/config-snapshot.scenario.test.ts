import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../../bin/lando.ts");
const fixture = async (body: string) => {
  const root = await mkdtemp(join(tmpdir(), "lando-config-cli-"));
  await writeFile(join(root, "config.yml"), body);
  await writeFile(join(root, ".lando.yml"), "name: config-snapshot\nservices: {}\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("LANDO_")));
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn([process.execPath, entry, ...args], {
      cwd: root,
      env: {
        ...env,
        LANDO_USER_CONF_ROOT: root,
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
        LANDO_TELEMETRY: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  return { root, run, close: () => rm(root, { recursive: true, force: true }) };
};

test.each(
  [
    ["info"],
    ["start"],
    ["list"],
    ["plugin:remove", "example"],
    ["app:config:lint"],
    ["global:config"],
    ["mcp", "--list"],
  ].map((args) => ({ args })),
)("$args returns sourced ConfigError at bootstrap", async ({ args }) => {
  const temp = await fixture("router:\n  httpPort: 99999\n");
  try {
    const result = await temp.run([...args, "--format=json"]);
    expect(result.code).toBe(1);
    const document = JSON.parse(result.stdout);
    const envelope = document._tag === "result" ? document.envelope : document;
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        _tag: "ConfigError",
        issues: [
          {
            path: ["router", "httpPort"],
            source: {
              layer: "config-file",
              file: join(temp.root, "config.yml"),
              path: ["router", "httpPort"],
            },
          },
        ],
      },
    });
  } finally {
    await temp.close();
  }
});

test("repair commands remain available under invalid config and notification promotion", async () => {
  const temp = await fixture(
    "router:\n  httpPort: 99999\nnotify:\n  enabled: true\n  commands:\n    - meta:config\n    - meta:doctor\n    - meta:uninstall\n    - meta:shellenv\n",
  );
  try {
    for (const args of [
      ["config", "view", "--source=raw"],
      ["version"],
      ["shellenv"],
      ["uninstall", "--help"],
      ["uninstall", "--dry-run"],
    ]) {
      const result = await temp.run([...args, "--format=json"]);
      expect({ args, code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(result.stdout).not.toContain('"_tag":"ConfigError"');
    }
    const invalid = await temp.run(["config", "validate", "--format=json"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout).error._tag).toBe("ConfigError");
    const doctor = await temp.run(["doctor", "--format=json"]);
    expect(doctor.code).toBe(1);
    const report = JSON.parse(doctor.stdout).result;
    expect(report.globalConfig).toMatchObject({ status: "fail", error: { _tag: "ConfigError" } });
    expect(report.skipped).toHaveLength(6);
    expect(report.subsystems.checks).toEqual([]);
    expect(doctor.stdout).not.toContain("--fix");
    const repaired = await temp.run(["config", "unset", "router.httpPort", "--format=json"]);
    expect(repaired.code).toBe(0);
    const valid = await temp.run(["config", "validate", "--format=json"]);
    expect(valid.code).toBe(0);
  } finally {
    await temp.close();
  }
}, 30_000);

test("source info prints a config typo warning once", async () => {
  const temp = await fixture("defaultProvidreId: docker\n");
  try {
    const result = await temp.run(["info"]);
    expect(result.code).toBe(0);
    expect(result.stderr.match(/defaultProvidreId/g)).toHaveLength(1);
  } finally {
    await temp.close();
  }
});
