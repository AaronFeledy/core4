import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileBunShellScriptCommands } from "@lando/engine/cache/command-compiler";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { discoverBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { Effect, Result } from "effect";
import { renderToolingHelp } from "../../src/cli/cli-help.ts";
import { splitCommandTokens } from "../../src/cli/invocation.ts";
import { ownerPolicy } from "../../src/cli/invocation-owner.ts";
import { type ToolingRoute, resolveToolingRoute } from "../../src/cli/tooling-router.ts";
import { CliInvocation, processInvocationDefaults } from "../../src/runtime/invocation-context";

const helpRequested = (route: ToolingRoute, argv: ReadonlyArray<string>): boolean => {
  switch (route._tag) {
    case "tooling":
    case "bun-script":
      return splitCommandTokens(argv, ownerPolicy({ kind: "tooling", route })).help;
    case "built-in":
    case "plugin":
    case "not-tooling":
    case "alias-disabled":
    case "cache-miss":
    case "unknown-tooling":
      return false;
    default:
      return route satisfies never;
  }
};

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");
const invocationEnv = (root: string, cacheRoot: string) => ({
  ...process.env,
  NO_COLOR: "1",
  LANDO_USER_CACHE_ROOT: cacheRoot,
  LANDO_USER_DATA_ROOT: join(root, "data"),
  LANDO_USER_CONF_ROOT: join(root, "conf"),
});
const fixtureRoute = (root: string, cacheRoot: string, token: string) =>
  resolveToolingRoute(token, { cwd: root, cacheRoot }).pipe(
    Effect.provideService(CliInvocation, {
      ...processInvocationDefaults,
      cwd: root,
      env: invocationEnv(root, cacheRoot),
    }),
  );
test.each([
  { argv: ["--help"], marker: null, exit: 0 },
  { argv: ["-h"], marker: null, exit: 0 },
  { argv: ["value", "--help"], marker: null, exit: 0 },
  { argv: ["--", "--help"], marker: "first=--help\nsecond=\n", exit: 0 },
  { argv: ["--version", "--format=json"], marker: null, exit: 2 },
  { argv: ["--version", "2.0"], marker: "first=--version\nsecond=2.0\n", exit: 0 },
])(
  "answers raw script help without executing except after --: $argv",
  async ({ argv, marker, exit }) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-raw-script-help-"));
    try {
      await mkdir(join(root, ".lando/scripts"), { recursive: true });
      await writeFile(join(root, ".lando.yml"), "name: raw-script-help\n");
      await writeFile(
        join(root, ".lando/scripts/wipe.bun.sh"),
        '# ---\n# desc: Record arguments\n# ---\nprintf "%s\\n" "first=$1" "second=$2" > marker\n',
      );
      // When
      const child = Bun.spawn([process.execPath, cli, "wipe", ...argv], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          NO_COLOR: "1",
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CONF_ROOT: join(root, "conf"),
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Then
      expect(code, stderr).toBe(exit);
      const file = Bun.file(join(root, "marker"));
      if (marker === null) {
        if (exit === 0) expect(stdout).toContain("lando wipe [args...]");
        else
          expect(JSON.parse(stdout)).toMatchObject({
            ok: false,
            command: "app:wipe",
            error: { _tag: "ToolingInputError", tool: "app:wipe", field: "version" },
          });
        expect(await file.exists()).toBe(false);
      } else expect(await file.text()).toBe(marker);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

const declared = [
  "# ---",
  "# desc: Greet a target",
  "# flags:",
  "#   name:",
  "#     alias: n",
  "#     default: world",
  "# args:",
  "#   target:",
  "#     required: true",
  "# ---",
  "echo must-not-execute",
  "",
].join("\n");

const withScript = async (cached: boolean, run: (root: string, cacheRoot: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-script-help-"));
  const cacheRoot = join(root, "cache");
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: [unparseable\n");
    if (cached) await writeFile(join(root, ".lando/scripts/greet.bun.sh"), declared);
    const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        cwd: root,
        cacheRoot,
        env: invocationEnv(root, cacheRoot),
        landofile: { name: "help", ...(cached ? { commandAliases: { custom: { hi: "app:greet" } } } : {}) },
        entries: compileBunShellScriptCommands(scripts),
      }),
    );
    if (!cached) await writeFile(join(root, ".lando/scripts/greet.bun.sh"), declared);
    await run(root, cacheRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([true, false])("carries normalized script help metadata when cached=%s", async (cached) => {
  // Given
  await withScript(cached, async (root, cacheRoot) => {
    const tokens = cached ? ["greet", "app:greet", "hi"] : ["greet", "app:greet"];
    // When
    const routes = await Promise.all(
      tokens.map((token) => Effect.runPromise(fixtureRoute(root, cacheRoot, token))),
    );
    // Then
    for (const route of routes) {
      expect(route).toMatchObject({
        _tag: "bun-script",
        commandId: "app:greet",
        name: "greet",
        summary: "Greet a target",
        hidden: false,
        service: ":host",
        appRoot: root,
        relativePath: "greet.bun.sh",
        runs: { kind: "script", path: ".lando/scripts/greet.bun.sh" },
        input: {
          flags: [{ name: "name", alias: "n", default: "world", boolean: false, required: false }],
          args: [{ name: "target", order: 0, required: true }],
        },
      });
      expect(helpRequested(route, ["--help"])).toBe(true);
    }
  });
});

test.each([
  { cached: true, argv: ["hi", "--help"] },
  { cached: false, argv: ["greet", "--help"] },
  { cached: false, argv: ["help", "app:greet"] },
])(
  "renders resolved help without inventory refresh for $argv (cached=$cached)",
  async ({ cached, argv }) => {
    // Given: invalid Landofile and unrelated script rule out planning or full inventory discovery.
    await withScript(cached, async (root, cacheRoot) => {
      await writeFile(join(root, ".lando/scripts/unrelated.bun.sh"), "invalid front matter");
      const route = await Effect.runPromise(fixtureRoute(root, cacheRoot, "greet"));
      if (route._tag !== "bun-script") throw new Error(`Expected script, got ${route._tag}`);
      const expected = renderToolingHelp(
        { ...route, id: route.commandId, source: "bun-script" },
        {
          styled: false,
          ...(route.aliasPolicy === undefined ? {} : { aliasPolicy: route.aliasPolicy }),
        },
      );
      // When
      const child = Bun.spawn([process.execPath, cli, ...argv], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: invocationEnv(root, cacheRoot),
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Then
      expect(code, stderr).toBe(0);
      expect(stdout.trim()).toBe(expected.trim());
      expect(stdout).toContain("--name");
      expect(stdout).toContain("TARGET");
      expect(stdout).toContain("Runs .lando/scripts/greet.bun.sh on the host.");
      expect(stdout + stderr).not.toContain("must-not-execute");
    });
  },
  30_000,
);

test.each([
  { argv: ["--help"], expected: true },
  { argv: ["-h"], expected: true },
  { argv: ["--", "--help"], expected: false },
  { argv: ["--help"], hidden: true, expected: true },
  {
    argv: ["--help"],
    input: Result.getOrThrowWith(
      normalizeToolingInput("greet", { flags: { help: { boolean: true } } }),
      (error) => error,
    ),
    expected: false,
  },
  {
    argv: ["-h"],
    input: Result.getOrThrowWith(
      normalizeToolingInput("greet", { flags: { hint: { alias: "h", boolean: true } } }),
      (error) => error,
    ),
    expected: false,
  },
  {
    argv: ["--help"],
    hidden: true,
    input: Result.getOrThrowWith(
      normalizeToolingInput("greet", { flags: { help: { boolean: true } } }),
      (error) => error,
    ),
    expected: false,
  },
  {
    argv: ["--help"],
    hidden: true,
    disabled: true,
    input: Result.getOrThrowWith(
      normalizeToolingInput("greet", { flags: { help: { boolean: true } } }),
      (error) => error,
    ),
    expected: true,
  },
])("preserves script help ownership for %j", ({ argv, expected, ...overrides }) => {
  // Given
  const input =
    "input" in overrides
      ? overrides.input
      : Result.getOrThrowWith(
          normalizeToolingInput("greet", { args: { target: { required: true } } }),
          (error) => error,
        );
  const metadata = {
    _tag: "bun-script" as const,
    commandId: "app:greet",
    name: "greet",
    summary: "Greet",
    hidden: overrides.hidden ?? false,
    appRoot: "/app",
    ...(input === undefined ? {} : { input }),
  };
  const route: ToolingRoute = overrides.disabled
    ? { ...metadata, disabled: true, sourcePath: "/app/.lando/scripts/greet.bun.sh" }
    : metadata;
  // When
  const requested = helpRequested(route, argv);
  // Then
  expect(requested).toBe(expected);
});

test("retains a newly discovered disabled script route for typed runtime refusal", async () => {
  // Given
  await withScript(false, async (root, cacheRoot) => {
    await writeFile(
      join(root, ".lando/scripts/greet.bun.sh"),
      declared.replace("# desc:", "# disabled: true\n# desc:"),
    );
    // When
    const route = await Effect.runPromise(fixtureRoute(root, cacheRoot, "greet"));
    // Then
    expect(route).toMatchObject({ _tag: "bun-script", hidden: true, disabled: true });
    expect(helpRequested(route, ["--help"])).toBe(true);
  });
});
