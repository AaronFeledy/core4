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
import {
  type ToolingRoute,
  resolveToolingRoute,
  toolingHelpRequested,
} from "../../src/cli/tooling-router.ts";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");
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
      tokens.map((token) => Effect.runPromise(resolveToolingRoute(token, { cwd: root, cacheRoot }))),
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
        input: {
          flags: [{ name: "name", alias: "n", default: "world", boolean: false, required: false }],
          args: [{ name: "target", order: 0, required: true }],
        },
      });
      expect(toolingHelpRequested(route, ["--help"])).toBe(true);
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
      const route = await Effect.runPromise(resolveToolingRoute("greet", { cwd: root, cacheRoot }));
      if (route._tag !== "bun-script") throw new Error(`Expected script, got ${route._tag}`);
      const expected = renderToolingHelp(
        { ...route, id: route.commandId },
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
        env: {
          ...process.env,
          NO_COLOR: "1",
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
      // Then
      expect(code, stderr).toBe(0);
      expect(stdout.trim()).toBe(expected.trim());
      expect(stdout).toContain("--name");
      expect(stdout).toContain("TARGET");
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
  { argv: ["--help"], input: undefined, expected: false },
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
  const route: ToolingRoute = {
    _tag: "bun-script",
    commandId: "app:greet",
    name: "greet",
    summary: "Greet",
    hidden: overrides.hidden ?? false,
    ...(overrides.disabled ? { disabled: true as const } : {}),
    appRoot: "/app",
    ...(input === undefined ? {} : { input }),
  };
  // When
  const requested = toolingHelpRequested(route, argv);
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
    const route = await Effect.runPromise(resolveToolingRoute("greet", { cwd: root, cacheRoot }));
    // Then
    expect(route).toMatchObject({ _tag: "bun-script", hidden: true, disabled: true });
    expect(toolingHelpRequested(route, ["--help"])).toBe(true);
  });
});
