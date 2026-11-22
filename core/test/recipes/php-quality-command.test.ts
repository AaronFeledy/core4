import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contribQualityTooling, siteQualityTooling } from "../../src/recipes/builtin/php-quality-command.ts";

const standard = "--standard=Drupal,DrupalPractice";
const extensions = "--extensions=engine,inc,info,install,module,php,profile,test,theme,yml";
const ignore = "--ignore=*/node_modules/*,*/vendor/*";
const defaults = [standard, extensions, ignore];

const runQuality = async (input: {
  readonly tool: keyof typeof siteQualityTooling;
  readonly contrib?: boolean;
  readonly cwd?: string;
  readonly dirs?: readonly string[];
  readonly configs?: readonly string[];
  readonly args?: readonly string[];
  readonly missing?: boolean;
  readonly toolExit?: number;
}) => {
  const root = await mkdtemp(join(tmpdir(), "lando quality-"));
  try {
    const webroot = join(root, "public");
    const appRoot = input.contrib ? join(webroot, "modules", "custom", "my module") : root;
    const cwd = join(appRoot, input.cwd ?? "");
    const binary = join(root, "vendor", "bin", input.tool);
    const dirs = (input.dirs ?? []).map((dir) => join(webroot, dir));
    await mkdir(cwd, { recursive: true });
    for (const dir of dirs) await mkdir(dir, { recursive: true });
    for (const config of input.configs ?? []) await writeFile(join(root, config), "");
    if (!input.missing) {
      await mkdir(join(root, "vendor", "bin"), { recursive: true });
      await writeFile(
        binary,
        `#!/bin/sh\nprintf 'BIN=%s\\n' "$0"\nfor arg do printf 'ARG=%s\\n' "$arg"; done\nexit ${input.toolExit ?? 0}\n`,
        { mode: 0o755 },
      );
    }
    const [cmd] = (input.contrib ? contribQualityTooling : siteQualityTooling)[input.tool].cmds;
    // Relocate the container's fixed /app vendor path into the temp site; never touch the host's /app.
    const script = input.contrib
      ? cmd.replaceAll(` /app/vendor/bin/${input.tool} `, ` "$TEST_SITE_ROOT/vendor/bin/${input.tool}" `)
      : cmd;
    const proc = Bun.spawnSync(["sh", "-c", script, "lando-tooling", ...(input.args ?? [])], {
      cwd,
      env: {
        ...process.env,
        PWD: cwd,
        LANDO_APP_ROOT: appRoot,
        LANDO_WEBROOT: webroot,
        TEST_SITE_ROOT: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      result: { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode },
      invoked: (args: readonly string[], exitCode = 0) => ({
        stdout: [`BIN=${binary}`, ...args.map((arg) => `ARG=${arg}`), ""].join("\n"),
        stderr: "",
        exitCode,
      }),
      appRoot,
      webroot,
      dirs,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

(process.platform === "win32" ? describe.skip : describe)("Drupal PHP quality tooling", () => {
  test.each([
    ["phpcs", "drupal/coder"],
    ["phpcbf", "drupal/coder"],
    ["phpstan", "phpstan/phpstan mglaman/phpstan-drupal phpstan/extension-installer"],
  ] as const)("%s reports the install command when the vendor binary is absent", async (tool, packages) => {
    const { result } = await runQuality({ tool, missing: true, args: ["--version"] });
    expect(result).toMatchObject({ stdout: "", exitCode: 1 });
    expect(result.stderr).toContain(`vendor/bin/${tool}`);
    const [installCommand] = result.stderr.match(/\blando composer require --dev [^\r\n]+/) ?? [];
    expect(installCommand?.trimEnd().replace(/\.$/, "")).toBe(`lando composer require --dev ${packages}`);
  });

  test.each([
    { cwd: "public", config: "public/.phpcs.xml", args: [] },
    { cwd: "public/modules/custom", config: "phpcs.xml.dist", args: ["my module"] },
  ])("PHPCS preserves the ruleset's control with $config", async ({ cwd, config, args }) => {
    const { result, invoked } = await runQuality({
      tool: "phpcs",
      cwd,
      configs: [config],
      dirs: ["modules/custom"],
      args,
    });
    expect(result).toEqual(invoked(args));
  });

  test.each(["phpcs", "phpcbf"] as const)("%s defaults to existing absolute custom paths", async (tool) => {
    const { result, invoked, dirs } = await runQuality({
      tool,
      cwd: "public/modules/custom",
      dirs: ["modules/custom", "profiles/custom"],
    });
    expect(result).toEqual(invoked([...defaults, ...dirs]));
  });

  test.each([
    ["phpcs", "phpcs.xml.dist"],
    ["phpstan", "phpstan.neon.dist"],
  ] as const)("%s exits without running the binary when no targets exist", async (tool, configName) => {
    const { result, webroot } = await runQuality({ tool, cwd: "public", toolExit: 42 });
    expect(result).toMatchObject({ stdout: "", exitCode: 1 });
    expect(result.stderr).toContain(configName);
    for (const dir of ["modules/custom", "themes/custom", "profiles/custom"]) {
      expect(result.stderr).toContain(join(webroot, dir));
    }
  });

  test.each([
    { args: ["--report=full", "my module/src", ""], injected: defaults },
    { args: ["src", "--standard=PSR12"], injected: [] },
    { args: ["--extensions=inc", "src"], injected: [standard, ignore] },
    { args: ["--ignore=*/generated files/*", "src"], injected: [standard, extensions] },
  ])(
    "PHPCS injects only applicable defaults for $args and keeps the exit status",
    async ({ args, injected }) => {
      const { result, invoked } = await runQuality({
        tool: "phpcs",
        args,
        dirs: ["modules/custom"],
        toolExit: 3,
      });
      expect(result).toEqual(invoked([...injected, ...args], 3));
    },
  );

  test("PHPStan forwards explicit argv unchanged even when a config exists", async () => {
    const args = ["--no-progress", "src/my module"];
    const { result, invoked } = await runQuality({ tool: "phpstan", args, configs: [".phpstan.neon"] });
    expect(result).toEqual(invoked(args));
  });

  test.each([
    {
      configs: ["public/phpstan.neon", "public/.phpstan.neon", ".phpstan.neon"],
      expected: "public/.phpstan.neon",
    },
    {
      configs: ["phpstan.dist.neon", ".phpstan.dist.neon", "phpstan.neon.dist"],
      expected: "phpstan.neon.dist",
    },
    { configs: ["public/phpstan.dist.neon", ".phpstan.neon"], expected: "public/phpstan.dist.neon" },
  ])(
    "PHPStan uses $expected according to directory and filename precedence",
    async ({ configs, expected }) => {
      const { result, invoked, appRoot } = await runQuality({
        tool: "phpstan",
        cwd: "public",
        dirs: ["themes/custom"],
        configs,
      });
      expect(result).toEqual(invoked(["analyse", `--configuration=${join(appRoot, expected)}`]));
    },
  );

  test("PHPStan analyses existing absolute custom paths without a config", async () => {
    const { result, invoked, dirs } = await runQuality({
      tool: "phpstan",
      cwd: "public",
      dirs: ["themes/custom"],
    });
    expect(result).toEqual(invoked(["analyse", ...dirs]));
  });

  test.each([
    ["phpcs", defaults],
    ["phpcbf", defaults],
    ["phpstan", ["analyse"]],
  ] as const)("contrib %s runs the site's binary on the extension root", async (tool, prefix) => {
    const { result, invoked, appRoot } = await runQuality({ tool, contrib: true, cwd: "src" });
    expect(result).toEqual(invoked([...prefix, appRoot]));
  });
});
