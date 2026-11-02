import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileBunShellScriptCommands } from "@lando/engine/cache/command-compiler";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { discoverBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { Effect } from "effect";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");

const withHelpApp = async (
  state: { readonly cached: boolean; readonly hidden: boolean },
  run: (root: string, cacheRoot: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-machine-target-help-"));
  const cacheRoot = join(root, "cache");
  const script = `# ---\n# disabled: ${state.hidden}\n# flags:\n#   mode:\n#     choices: [dev, prod]\n#     default: dev\n# ---\necho ran > executed\n`;
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: [invalid\n");
    if (state.cached) await writeFile(join(root, ".lando/scripts/probe.bun.sh"), script);
    const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        cwd: root,
        cacheRoot,
        landofile: { name: "machine-help" },
        entries: compileBunShellScriptCommands(scripts),
      }),
    );
    if (!state.cached) await writeFile(join(root, ".lando/scripts/probe.bun.sh"), script);
    await writeFile(join(root, ".lando/scripts/unrelated.bun.sh"), "invalid metadata");
    await run(root, cacheRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runHelp = async (root: string, cacheRoot: string, argv: readonly string[]) => {
  const child = Bun.spawn([process.execPath, cli, ...argv, "--format=json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

test("explicit machine help rejects an unknown target instead of returning a root catalog", async () => {
  // Given
  await withHelpApp({ cached: true, hidden: false }, async (root, cacheRoot) => {
    // When
    const result = await runHelp(root, cacheRoot, ["help", "app:absent"]);
    // Then
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "app:absent",
      ok: false,
      error: { _tag: "ToolingCommandUnavailableError", reason: "unknown-command" },
    });
  });
});

test.each([true, false])("machine help returns the selected declaration when cached=%s", async (cached) => {
  // Given
  await withHelpApp({ cached, hidden: false }, async (root, cacheRoot) => {
    // When
    const result = await runHelp(root, cacheRoot, ["help", "app:probe"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "cli:help",
      ok: true,
      result: {
        target: {
          canonicalId: "app:probe",
          source: "tooling",
          input: {
            flags: [{ name: "mode", choices: ["dev", "prod"], default: "dev" }],
            revision: expect.any(String),
          },
        },
      },
    });
    expect(await Bun.file(join(root, "executed")).exists()).toBe(false);
  });
});

test.each([{ argv: ["--help"] }, { argv: ["--help", "--all"] }, { argv: ["help", "app"] }])(
  "root and topic machine help remain structured for $argv",
  async ({ argv }) => {
    // Given
    await withHelpApp({ cached: true, hidden: false }, async (root, cacheRoot) => {
      // When
      const result = await runHelp(root, cacheRoot, argv);
      // Then
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "cli:help",
        ok: true,
        result: { toolingMetadata: { status: "fresh" }, all: expect.any(Array) },
      });
    });
  },
);

test.each([{ argv: ["probe", "--help"] }, { argv: ["help", "app:probe"] }])(
  "hidden target help refuses before execution for $argv",
  async ({ argv }) => {
    // Given
    await withHelpApp({ cached: true, hidden: true }, async (root, cacheRoot) => {
      // When
      const result = await runHelp(root, cacheRoot, argv);
      // Then
      expect(result.code, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "app:probe",
        ok: false,
        error: { _tag: "ToolingDisabledError", tool: "probe" },
      });
      expect(await Bun.file(join(root, "executed")).exists()).toBe(false);
    });
  },
);
