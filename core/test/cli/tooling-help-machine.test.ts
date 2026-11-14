import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileInspectedAppCommands } from "@lando/engine/cache/command-compiler";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { fingerprintsFromInspection } from "@lando/engine/cache/command-script-freshness";
import { inspectBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { createRedactor } from "@lando/sdk/secrets";
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
    await writeFile(join(root, ".lando/scripts/unrelated.bun.sh"), "invalid metadata");
    const scripts = await Effect.runPromise(inspectBunShellScripts({ appRoot: root }));
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        cwd: root,
        cacheRoot,
        landofile: { name: "machine-help" },
        entries: compileInspectedAppCommands({
          sourcePath: root,
          landofile: { name: "machine-help" },
          inspection: scripts,
          redact: createRedactor("secrets").redactString,
        }),
        sourceScripts: fingerprintsFromInspection(scripts),
      }),
    );
    if (!state.cached) await writeFile(join(root, ".lando/scripts/probe.bun.sh"), script);
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

test("built-in machine help carries declared flags and positional arguments (#2053)", async () => {
  await withHelpApp({ cached: true, hidden: false }, async (root, cacheRoot) => {
    const result = await runHelp(root, cacheRoot, ["help", "exec"]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result.target.input).toEqual({
      flags: [
        {
          name: "service",
          type: "string",
          description: "Service to run the command in (default: the primary service).",
          required: false,
          multiple: false,
          char: "s",
        },
        {
          name: "user",
          type: "string",
          description: "User to run the command as inside the service.",
          required: false,
          multiple: false,
          char: "u",
        },
        {
          name: "cwd",
          type: "string",
          description: "Working directory inside the service.",
          required: false,
          multiple: false,
        },
        {
          name: "interactive",
          type: "boolean",
          description: "Attach your terminal keyboard to the command. Piped stdin is always attached.",
          required: false,
          multiple: false,
          default: false,
          char: "i",
        },
      ],
      args: [
        {
          name: "command",
          description: "Command argv after `--`. An optional service name may come first.",
          required: false,
          multiple: true,
        },
      ],
    });
  });
});

test("built-in config machine help carries positional choices", async () => {
  await withHelpApp({ cached: true, hidden: false }, async (root, cacheRoot) => {
    const result = await runHelp(root, cacheRoot, ["config", "--help"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result.target.input.args[0]).toMatchObject({
      name: "subcommand",
      options: ["view", "get", "set", "unset", "edit", "validate", "describe", "telemetry", "translate"],
    });
  });
});

test("explicit machine help rejects an unknown target instead of returning a root catalog", async () => {
  // Given
  await withHelpApp({ cached: true, hidden: false }, async (root, cacheRoot) => {
    // When
    const result = await runHelp(root, cacheRoot, ["help", "app:absent"]);
    // Then
    expect(result.code, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "cli:unknown-command",
      ok: false,
      error: { _tag: "UnknownCommandError", commandToken: "app:absent" },
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
          runs: { kind: "script", path: ".lando/scripts/probe.bun.sh" },
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

test.each([
  { command: "info", afterName: "until-separator", commandOwned: [] },
  { command: "logs", afterName: "until-separator", commandOwned: ["--tail"] },
  { command: "exec", afterName: "command-tail", commandOwned: [] },
  { command: "bun", afterName: "none", commandOwned: [] },
] as const)(
  "machine help carries the flag placement for $command",
  async ({ command, afterName, commandOwned }) => {
    await withHelpApp({ cached: true, hidden: false }, async (root, cacheRoot) => {
      const result = await runHelp(root, cacheRoot, ["help", command]);

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).result.target.landoFlags).toEqual({
        afterName,
        commandOwned,
      });
    });
  },
  30_000,
);
