import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PHPCBF_MISSING_HINT,
  PHPCBF_TOOLING_COMMAND,
  PHPCS_MISSING_HINT,
  PHPCS_TOOLING_COMMAND,
  PHPSTAN_MISSING_HINT,
  PHPSTAN_TOOLING_COMMAND,
  phpQualityToolingCommand,
} from "../../src/recipes/builtin/php-quality-command.ts";
import { phpcbfTool, phpcsTool, phpstanTool } from "../../src/recipes/builtin/source-php.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const runQuality = async (input: {
  readonly binary: "phpcs" | "phpcbf" | "phpstan";
  readonly args?: ReadonlyArray<string>;
  readonly missing?: string;
  readonly defaultArgs?: ReadonlyArray<string>;
  readonly install?: boolean;
  readonly modules?: boolean;
  readonly themes?: boolean;
}) => {
  const root = await mkdtemp(join(tmpdir(), "lando-php-quality-"));
  roots.push(root);
  if (input.install === true) {
    await mkdir(join(root, "vendor", "bin"), { recursive: true });
    const stub = join(root, "vendor", "bin", input.binary);
    await writeFile(
      stub,
      '#!/bin/sh\nprintf "BIN=%s\\n" "$(basename "$0")"\nfor arg do printf "ARG=%s\\n" "$arg"; done\n',
    );
    await chmod(stub, 0o755);
  }
  if (input.modules === true) await mkdir(join(root, "web", "modules", "custom"), { recursive: true });
  if (input.themes === true) await mkdir(join(root, "web", "themes", "custom"), { recursive: true });
  const command = phpQualityToolingCommand(input.binary, input.missing ?? "missing-bin", {
    webroot: "web",
    ...(input.defaultArgs === undefined ? {} : { defaultArgs: input.defaultArgs }),
  });
  const proc = Bun.spawn(["sh", "-c", command, "lando-tooling", ...(input.args ?? [])], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

(process.platform === "win32" ? describe.skip : describe)("Drupal site PHP quality tooling", () => {
  test("keeps thin recipe objects on vendor/bin wrappers", () => {
    expect(phpcsTool).toMatchObject({
      service: "appserver",
      cmds: ["vendor/bin/phpcs"],
      wrapper: true,
    });
    expect(phpcbfTool).toMatchObject({
      service: "appserver",
      cmds: ["vendor/bin/phpcbf"],
      wrapper: true,
    });
    expect(phpstanTool).toMatchObject({
      service: "appserver",
      cmds: ["vendor/bin/phpstan"],
      wrapper: true,
    });
  });

  test("site preludes keep recipe webroot interpolation and forwarded arguments", () => {
    for (const command of [PHPCS_TOOLING_COMMAND, PHPCBF_TOOLING_COMMAND, PHPSTAN_TOOLING_COMMAND]) {
      expect(command).toContain("{{ recipe.webroot }}");
      expect(command).toContain("exec vendor/bin/");
      expect(command).toContain('"$@"');
      expect(command).not.toContain("${");
      expect(command).not.toContain("composer require");
    }
    expect(PHPCS_TOOLING_COMMAND).toContain(PHPCS_MISSING_HINT);
    expect(PHPCBF_TOOLING_COMMAND).toContain(PHPCBF_MISSING_HINT);
    expect(PHPSTAN_TOOLING_COMMAND).toContain(PHPSTAN_MISSING_HINT);
    expect(PHPSTAN_TOOLING_COMMAND).toContain('set -- "analyse"');
  });

  test.each([
    { binary: "phpcs" as const, hint: PHPCS_MISSING_HINT, defaultArgs: [] as const },
    { binary: "phpcbf" as const, hint: PHPCBF_MISSING_HINT, defaultArgs: [] as const },
    { binary: "phpstan" as const, hint: PHPSTAN_MISSING_HINT, defaultArgs: ["analyse"] as const },
  ])("hints for a missing $binary without installing it", async ({ binary, hint, defaultArgs }) => {
    const result = await runQuality({ binary, missing: hint, defaultArgs });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${hint}\n`);
  });

  test("phpcs with no arguments lints only custom directories that exist", async () => {
    const result = await runQuality({ binary: "phpcs", install: true, modules: true, themes: true });
    expect(result).toEqual({
      stdout: "BIN=phpcs\nARG=web/modules/custom\nARG=web/themes/custom\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("phpcs with no arguments keeps no-arg behavior when custom directories are absent", async () => {
    const result = await runQuality({ binary: "phpcs", install: true });
    expect(result).toEqual({
      stdout: "BIN=phpcs\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("phpcs with no arguments skips a missing custom directory", async () => {
    const result = await runQuality({ binary: "phpcs", install: true, modules: true });
    expect(result).toEqual({
      stdout: "BIN=phpcs\nARG=web/modules/custom\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("phpcs forwards explicit arguments instead of default paths", async () => {
    const result = await runQuality({
      binary: "phpcs",
      install: true,
      modules: true,
      themes: true,
      args: ["--standard=Drupal", "web/modules/custom/example"],
    });
    expect(result).toEqual({
      stdout: "BIN=phpcs\nARG=--standard=Drupal\nARG=web/modules/custom/example\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("phpstan with no arguments runs analyse on existing custom directories", async () => {
    const result = await runQuality({
      binary: "phpstan",
      install: true,
      modules: true,
      themes: true,
      defaultArgs: ["analyse"],
    });
    expect(result).toEqual({
      stdout: "BIN=phpstan\nARG=analyse\nARG=web/modules/custom\nARG=web/themes/custom\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("phpstan with no arguments still runs analyse when custom directories are absent", async () => {
    const result = await runQuality({ binary: "phpstan", install: true, defaultArgs: ["analyse"] });
    expect(result).toEqual({
      stdout: "BIN=phpstan\nARG=analyse\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("phpstan forwards explicit arguments instead of default analyse paths", async () => {
    const result = await runQuality({
      binary: "phpstan",
      install: true,
      modules: true,
      defaultArgs: ["analyse"],
      args: ["analyse", "--no-progress", "src"],
    });
    expect(result).toEqual({
      stdout: "BIN=phpstan\nARG=analyse\nARG=--no-progress\nARG=src\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
