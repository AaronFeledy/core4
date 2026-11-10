import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");
const withApp = async (
  run: (
    root: string,
    call: (argv: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
  ) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-broken-script-cli-"));
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(
      join(root, ".lando.yml"),
      "name: script-isolation\ntooling:\n  ping:\n    service: :host\n    cmd: echo landofile-ok\n",
    );
    await writeFile(join(root, ".lando/scripts/bad.bun.sh"), "echo broken\n");
    await writeFile(
      join(root, ".lando/scripts/good.bun.sh"),
      "# ---\n# desc: Healthy\n# ---\necho script-ok\n",
    );
    const call = async (argv: readonly string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...argv], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          LANDO_USER_CONF_ROOT: join(root, "conf"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    await run(root, call);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("refresh warns but preserves healthy commands on a cold index (#2210)", async () => {
  await withApp(async (_root, call) => {
    const refresh = await call(["app:cache:refresh", "--format=json"]);
    expect(refresh.code, refresh.stderr).toBe(0);
    expect(JSON.parse(refresh.stdout)).toMatchObject({
      ok: true,
      result: { commandsCompiled: 3 },
      warnings: [{ code: "LANDO_SCRIPT_INVALID", context: { path: expect.stringContaining("bad.bun.sh") } }],
    });
  });
});

test.each([
  { name: "ping", output: "landofile-ok\n" },
  { name: "good", output: "script-ok\n" },
])("runs $name through a silent implicit rebuild despite a broken script", async ({ name, output }) => {
  await withApp(async (_root, call) => {
    const result = await call([name, "--format=json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { stdout: output }, warnings: [] });
  });
});

test.each([{ argv: ["bad"] }, { argv: ["bad", "--help"] }, { argv: ["help", "bad"] }])(
  "refuses the broken script with its own live error for $argv",
  async ({ argv }) => {
    await withApp(async (_root, call) => {
      const result = await call([...argv, "--format=json"]);
      expect(result.code, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "app:bad",
        ok: false,
        error: { _tag: "BunShellScriptFrontMatterError", path: expect.stringContaining("bad.bun.sh") },
      });
    });
  },
);

test("a broken script added after the index was built answers as its own command", async () => {
  await withApp(async (root, call) => {
    expect((await call(["ping", "--format=json"])).code).toBe(0);
    await writeFile(join(root, ".lando/scripts/late.bun.sh"), "echo late\n");
    for (const argv of [["late"], ["late", "--help"], ["help", "late"]]) {
      const result = await call([...argv, "--format=json"]);
      expect(result.code, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "app:late",
        error: { _tag: "BunShellScriptFrontMatterError", path: expect.stringContaining("late.bun.sh") },
      });
    }
  });
});

test("help refuses a healthy script once a collision appears after indexing", async () => {
  await withApp(async (root, call) => {
    expect((await call(["good", "--format=json"])).code).toBe(0);
    await writeFile(join(root, ".lando/scripts/good-.bun.sh"), "# ---\n# desc: Twin\n# ---\necho twin\n");
    for (const argv of [["good"], ["good", "--help"], ["help", "good"]]) {
      const result = await call([...argv, "--format=json"]);
      expect(result.code, `${argv.join(" ")}: ${result.stdout}`).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ command: "app:good", ok: false });
    }
  });
});

test("lists the unavailable script in human help and machine catalogs", async () => {
  await withApp(async (_root, call) => {
    const human = await call(["--help"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("[unavailable]");
    expect(human.stdout).toContain("lando app:config:lint");
    const machine = await call(["help", "--format=json"]);
    const catalog = JSON.parse(machine.stdout);
    expect(catalog.result.toolingMetadata).toEqual({ status: "fresh" });
    expect(
      catalog.result.sections.thisApp.find((row: { canonicalId: string }) => row.canonicalId === "app:bad"),
    ).toMatchObject({ source: "tooling", loadError: { _tag: "BunShellScriptFrontMatterError" } });
    expect(
      catalog.result.all.find((row: { canonicalId: string }) => row.canonicalId === "app:bad"),
    ).toHaveProperty("loadError");
  });
});

test("picks up a repair on the next invocation", async () => {
  await withApp(async (root, call) => {
    await call(["app:cache:refresh", "--format=json"]);
    await writeFile(join(root, ".lando/scripts/bad.bun.sh"), "# ---\n# ---\necho fixed\n");
    const result = await call(["bad", "--format=json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { stdout: "fixed\n" } });
  });
});

test("refuses a new collision on a warm index and names every conflicting path", async () => {
  await withApp(async (root, call) => {
    await call(["app:cache:refresh", "--format=json"]);
    await writeFile(join(root, ".lando/scripts/GOOD.bun.sh"), "broken colliding metadata\n");
    const result = await call(["good", "--format=json"]);
    expect(result.code).toBe(1);
    const error = JSON.parse(result.stdout).error;
    expect(error._tag).toBe("BunShellScriptFrontMatterError");
    expect(error.message).toContain("good.bun.sh");
    expect(error.message).toContain("GOOD.bun.sh");
  });
});

test("keeps Landofile precedence over a broken or ambiguous script id", async () => {
  await withApp(async (root, call) => {
    await writeFile(join(root, ".lando/scripts/ping.bun.sh"), "broken\n");
    await writeFile(join(root, ".lando/scripts/PING.bun.sh"), "also broken\n");
    const result = await call(["ping", "--format=json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { stdout: "landofile-ok\n" } });
  });
});

test("still fails a task bracket hook that explicitly invokes the broken script", async () => {
  await withApp(async (root, call) => {
    await writeFile(
      join(root, ".lando.yml"),
      "name: script-isolation\ntooling:\n  ping:\n    service: :host\n    cmd: echo should-not-run\nevents:\n  pre-ping:\n    - task: bad\n",
    );
    const result = await call(["ping", "--format=json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("should-not-run");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        _tag: "LandofileEventStepFailedError",
        kind: "task",
        outputTail: expect.stringContaining("bad.bun.sh is missing the front-matter block"),
      },
    });
  });
});
