import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");
const source = `name: task-isolation
includes:
  - source: ./internal.yml
    kind: tooling
    namespace: private
    internal: true
tooling:
  healthy:
    service: :host
    cmd: echo healthy-ok
  broken:
    service: :host
    wrapper: true
    flags:
      target:
        required: true
    cmds:
      - touch body-effect
      - echo invalid
    vars:
      value:
        sh: touch var-effect
  aliasclash:
    service: :host
    cmd: touch body-effect
    flags:
      first:
        alias: q
      second:
        alias: q
  retired:
    disabled: true
    wrapper: true
    service: :host
    cmds:
      - touch body-effect
      - echo invalid
    flags:
      first:
        alias: q
      second:
        alias: q
events:
  pre-broken:
    - cmd: touch hook-effect
      service: :host
`;

const withApp = async (
  run: (
    root: string,
    call: (argv: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
  ) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-broken-task-cli-"));
  try {
    await writeFile(join(root, ".lando.yml"), source);
    await writeFile(
      join(root, "internal.yml"),
      "tooling:\n  bad:\n    wrapper: true\n    flags:\n      first:\n        alias: q\n      second:\n        alias: q\n  good:\n    cmd: echo private\n",
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
    for (const path of ["body-effect", "var-effect", "hook-effect"])
      expect(await Bun.file(join(root, path)).exists(), path).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("refresh warns for invalid tooling and retains healthy and disabled siblings (#2325)", async () => {
  await withApp(async (_root, call) => {
    const result = await call(["app:cache:refresh", "--format=json"]);
    expect(result.code, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ ok: true, result: { commandsCompiled: 6 } });
    expect(
      envelope.warnings.map((warning: { code: string; context: { task: string } }) => [
        warning.code,
        warning.context.task,
      ]),
    ).toEqual([
      ["LANDO_TOOLING_INVALID", "aliasclash"],
      ["LANDO_TOOLING_INVALID", "broken"],
      ["LANDO_TOOLING_INVALID", "private:bad"],
    ]);
    expect(envelope.warnings[0]).toMatchObject({
      issues: [
        {
          reason: "alias-collision",
          path: ["tooling", "aliasclash", "flags", "second", "alias"],
          related: [
            {
              path: ["tooling", "aliasclash", "flags", "first", "alias"],
              source: { file: expect.stringContaining(".lando.yml") },
            },
          ],
        },
      ],
      omittedIssueCount: 0,
    });
    expect(envelope.warnings[2]).toMatchObject({
      context: { path: expect.stringContaining("internal.yml") },
      issues: expect.arrayContaining([
        expect.objectContaining({
          reason: "alias-collision",
          path: ["tooling", "private:bad", "flags", "second", "alias"],
          source: {
            file: expect.stringContaining("internal.yml"),
            layer: "canonical",
            path: ["tooling", "bad", "flags", "second", "alias"],
          },
          related: [
            {
              path: ["tooling", "private:bad", "flags", "first", "alias"],
              source: {
                file: expect.stringContaining("internal.yml"),
                layer: "canonical",
                path: ["tooling", "bad", "flags", "first", "alias"],
              },
            },
          ],
        }),
      ]),
    });
  });
});

test.each([
  { argv: ["healthy"], output: "healthy-ok\n" },
  { argv: ["healthy", "--help"] },
  { argv: ["help", "healthy"] },
])("healthy sibling succeeds with a quiet implicit rebuild for $argv", async ({ argv, output }) => {
  await withApp(async (_root, call) => {
    const result = await call([...argv, "--format=json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      warnings: [],
      ...(output === undefined ? {} : { result: { stdout: output } }),
    });
  });
});

test.each(
  ["broken", "aliasclash", "app:private:bad"].flatMap((name) => [
    { argv: [name] },
    { argv: [name, "--help"] },
    { argv: ["help", name] },
    { argv: [name, "--version"] },
    ...(name === "broken" ? [{ argv: [name, "--unknown"] }, { argv: [name, "--target=web"] }] : []),
  ]),
)("invalid tooling fails with its compile error without effects for $argv", async ({ argv }) => {
  await withApp(async (_root, call) => {
    const result = await call([...argv, "--format=json"]);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    const failure = JSON.parse(result.stdout);
    expect(failure).toMatchObject({
      ok: false,
      error: {
        _tag: "ToolingCompileError",
        omittedIssueCount: 0,
        issues: expect.arrayContaining([
          expect.objectContaining({
            reason:
              argv.includes("aliasclash") || argv.includes("app:private:bad")
                ? "alias-collision"
                : "wrapper-inputs",
            source: {
              layer: "canonical",
              file: expect.stringContaining(argv.includes("app:private:bad") ? "internal.yml" : ".lando.yml"),
              path: expect.any(Array),
            },
          }),
        ]),
      },
    });
    expect(failure.error).not.toHaveProperty("cause");
  });
});

test.each([{ argv: ["retired"] }, { argv: ["retired", "--help"] }, { argv: ["help", "retired"] }])(
  "disabled refusal takes precedence over malformed input and wrapper for $argv",
  async ({ argv }) => {
    await withApp(async (_root, call) => {
      const result = await call([...argv, "--format=json"]);
      expect(result.code, result.stdout + result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { _tag: "ToolingDisabledError" } });
    });
  },
);

test("internal unavailable tasks stay hidden while healthy internal direct help works", async () => {
  await withApp(async (_root, call) => {
    const catalog = await call(["help", "--format=json"]);
    expect(catalog.code, catalog.stderr).toBe(0);
    const rows = JSON.parse(catalog.stdout).result.sections.thisApp;
    expect(rows.map((row: { canonicalId: string }) => row.canonicalId)).toEqual([
      "app:aliasclash",
      "app:broken",
      "app:healthy",
    ]);
    expect(rows.find((row: { canonicalId: string }) => row.canonicalId === "app:broken")).toHaveProperty(
      "loadError",
    );
    expect(rows.find((row: { canonicalId: string }) => row.canonicalId === "app:aliasclash")).toMatchObject({
      loadError: {
        issues: [
          {
            reason: "alias-collision",
            path: ["tooling", "aliasclash", "flags", "second", "alias"],
            related: [
              {
                path: ["tooling", "aliasclash", "flags", "first", "alias"],
                source: expect.objectContaining({ file: expect.stringContaining(".lando.yml") }),
              },
            ],
          },
        ],
        omittedIssueCount: 0,
      },
    });
    const help = await call(["help", "app:private:good", "--format=json"]);
    expect(help.code, help.stderr).toBe(0);
    expect(JSON.parse(help.stdout)).toMatchObject({
      ok: true,
      result: { target: { canonicalId: "app:private:good" } },
    });
  });
});

test("an invalid Landofile task keeps precedence over a same-name healthy script", async () => {
  await withApp(async (root, call) => {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando/scripts/broken.bun.sh"), "# ---\n# ---\ntouch body-effect\n");
    const result = await call(["broken", "--format=json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { _tag: "ToolingCompileError" } });
  });
});

test("repairing the task recovers automatically on the next invocation", async () => {
  await withApp(async (root, call) => {
    expect((await call(["app:cache:refresh", "--format=json"])).code).toBe(0);
    await writeFile(
      join(root, ".lando.yml"),
      "name: task-isolation\ntooling:\n  broken:\n    service: :host\n    cmd: echo repaired\n",
    );
    const result = await call(["broken", "--format=json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      result: { stdout: "repaired\n" },
      warnings: [],
    });
  });
});
