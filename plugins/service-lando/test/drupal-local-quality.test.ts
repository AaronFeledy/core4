import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drupalLocalLauncher } from "../src/services/drupal-local-launcher.ts";

const standard = "--standard=Drupal,DrupalPractice";
const extensions = "--extensions=engine,inc,info,install,module,php,profile,test,theme,yml";
const ignore = "--ignore=*/node_modules/*,*/vendor/*";
const defaults = [standard, extensions, ignore];

const runQuality = async (input: {
  readonly tool: string;
  readonly contrib?: boolean;
  readonly cwd?: string;
  readonly dirs?: readonly string[];
  readonly configs?: readonly string[];
  readonly args?: readonly string[];
  readonly missing?: boolean;
  readonly mode?: number;
  readonly composerDir?: string;
  readonly toolExit?: number;
}) => {
  const root = await mkdtemp(join(tmpdir(), "lando quality-"));
  try {
    const webroot = join(root, "public");
    const appRoot = input.contrib ? join(webroot, "modules", "custom", "my module") : root;
    const cwd = join(appRoot, input.cwd ?? "");
    const siteRoot = join(root, input.composerDir ?? "");
    const binary = join(siteRoot, "vendor", "bin", input.tool);
    const dirs = (input.dirs ?? []).map((dir) => join(webroot, dir));
    await mkdir(cwd, { recursive: true });
    await mkdir(siteRoot, { recursive: true });
    if (input.composerDir !== undefined || input.contrib)
      await writeFile(join(siteRoot, "composer.json"), "{}");
    for (const dir of dirs) await mkdir(dir, { recursive: true });
    for (const config of input.configs ?? []) await writeFile(join(root, config), "");
    if (!input.missing) {
      await mkdir(join(siteRoot, "vendor", "bin"), { recursive: true });
      await writeFile(
        binary,
        `#!/bin/sh\nprintf 'BIN=%s\\n' "$0"\nfor arg do printf 'ARG=%s\\n' "$arg"; done\nexit ${input.toolExit ?? 0}\n`,
        { mode: input.mode ?? 0o755 },
      );
    }
    const proc = Bun.spawnSync([...drupalLocalLauncher, input.tool, ...(input.args ?? [])], {
      cwd,
      env: {
        ...process.env,
        PWD: cwd,
        LANDO_APP_ROOT: appRoot,
        LANDO_WEBROOT: webroot,
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
    { cwd: "public", config: "public/phpcs.xml", args: [] },
    { cwd: "public", config: ".phpcs.xml.dist", args: [] },
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
    { args: ["--", "--standard=PSR12", "-cfile"], injected: defaults },
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

  test.each(["analyse", "analyze"])("PHPStan inserts the discovered config after %s", async (subcommand) => {
    const { result, invoked, appRoot } = await runQuality({
      tool: "phpstan",
      cwd: "public/modules/custom/x",
      configs: ["phpstan.neon"],
      args: [subcommand, "src with spaces", ""],
    });
    expect(result).toEqual(
      invoked([subcommand, `--configuration=${join(appRoot, "phpstan.neon")}`, "src with spaces", ""]),
    );
  });

  test.each(
    [
      ["-c", "custom.neon"],
      ["-ccustom.neon"],
      ["--configuration", "custom.neon"],
      ["--configuration=custom.neon"],
    ].map((configArgs) => ({ configArgs })),
  )("PHPStan preserves explicit config arguments %p", async ({ configArgs }) => {
    const args = ["analyse", "src", ...configArgs];
    const { result, invoked } = await runQuality({ tool: "phpstan", configs: ["phpstan.neon"], args });
    expect(result).toEqual(invoked(args));
  });

  test("PHPStan still inserts the discovered config when -c only appears after --", async () => {
    const { result, invoked, appRoot } = await runQuality({
      tool: "phpstan",
      configs: ["phpstan.neon"],
      args: ["analyse", "--", "-cfile"],
    });
    expect(result).toEqual(
      invoked(["analyse", `--configuration=${join(appRoot, "phpstan.neon")}`, "--", "-cfile"]),
    );
  });

  test("PHPStan preserves analysis arguments when no config exists", async () => {
    const args = ["analyse", "src"];
    const { result, invoked } = await runQuality({ tool: "phpstan", args });
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
    { configs: ["public/.phpstan.neon.dist"], expected: "public/.phpstan.neon.dist" },
    { configs: ["public/.phpstan.dist.neon"], expected: "public/.phpstan.dist.neon" },
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

  test.each([
    ["phpcs", "Run lando drupal-contrib-sync."],
    ["phpcbf", "Run lando drupal-contrib-sync."],
    ["drush", "Run lando drupal-contrib-sync."],
    [
      "phpstan",
      "Add phpstan/phpstan to require-dev in the extension composer.json, then run lando drupal-contrib-sync.",
    ],
  ])("contrib %s gives a sync hint when the site binary is not executable", async (tool, hint) => {
    const { result } = await runQuality({ tool, contrib: true, mode: 0o644 });
    expect(result).toMatchObject({ stdout: "", exitCode: 1 });
    expect(result.stderr).toEndWith(`/vendor/bin/${tool} is not installed. ${hint}\n`);
  });

  test("finds the nearest composer.json including webroot and passes unknown tools through", async () => {
    const args = ["a b", ""];
    const { result, invoked } = await runQuality({
      tool: "phpunit",
      cwd: "public/modules",
      composerDir: "public",
      configs: ["composer.json"],
      args,
    });
    expect(result).toEqual(invoked(args));
  });

  test("reports the absolute binary path for an unknown tool", async () => {
    const { result, appRoot } = await runQuality({ tool: "phpunit", missing: true });
    expect(result).toEqual({
      stdout: "",
      stderr: `${appRoot}/vendor/bin/phpunit is not installed.\n`,
      exitCode: 1,
    });
  });
});
