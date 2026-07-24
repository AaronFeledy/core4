import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DRUPAL_SCAFFOLD_COMMAND } from "../../src/recipes/builtin/drupal/render.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = async (
  command: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...command],
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const withTempDir = async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-drupal-recipe-"));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("lando init — Drupal recipe", () => {
  test("renders the scaffold workflow through the OCLIF adapter", async () => {
    await withTempDir(async (dir) => {
      // Given
      const appDir = join(dir, "drupal-app");

      // When
      const result = await run(
        [
          process.execPath,
          cliEntry,
          "init",
          "drupal-app",
          "--recipe=drupal",
          "--no-interactive",
          "--answer=name=drupal-app",
          "--answer=php=8.3",
          "--answer=database=mariadb",
        ],
        dir,
        { LANDO_USER_DATA_ROOT: join(dir, "lando-data") },
      );

      // Then
      expect(result.exitCode).toBe(0);
      const landofile = await Bun.file(join(appDir, ".lando.yml")).text();
      expect(landofile).toContain("webroot: /app/web");
      expect(landofile).toContain("allowOverride: true");
      expect(landofile).toContain("vendor/bin/drush");
      expect(landofile).toContain("drupal-scaffold:");
    });
  });

  test("recovers from an interrupted copy with a stale staged tree", async () => {
    await withTempDir(async (dir) => {
      // Given
      const appRoot = join(dir, "app");
      const stagingRoot = join(dir, "staging");
      const binDir = join(dir, "bin");
      const composerLog = join(dir, "composer.log");
      await mkdir(join(appRoot, "vendor"), { recursive: true });
      await mkdir(stagingRoot, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(join(appRoot, "composer.json"), "stale");
      await writeFile(join(appRoot, ".lando-drupal-scaffold-copying"), "composer.json\nvendor\n");
      await writeFile(join(stagingRoot, ".lando-drupal-stage-complete"), "");
      await writeFile(join(stagingRoot, "composer.json"), "incomplete");
      const composer = join(binDir, "composer");
      await writeFile(
        composer,
        [
          "#!/bin/sh",
          "set -eu",
          'printf "%s\\n" "$*" >> "$COMPOSER_LOG"',
          'if test "$1" = create-project; then',
          '  mkdir -p "$3"',
          '  printf "%s\\n" fresh > "$3/composer.json"',
          "else",
          "  destination=${1#--working-dir=}",
          '  mkdir -p "$destination/vendor/bin"',
          '  printf "#!/bin/sh\\nexit 0\\n" > "$destination/vendor/bin/drush"',
          '  chmod +x "$destination/vendor/bin/drush"',
          "fi",
        ].join("\n"),
      );
      await chmod(composer, 0o755);

      // When
      const result = await run(["sh", "-c", DRUPAL_SCAFFOLD_COMMAND], dir, {
        COMPOSER_LOG: composerLog,
        LANDO_DRUPAL_APP_ROOT: appRoot,
        LANDO_DRUPAL_STAGING_ROOT: stagingRoot,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(appRoot, "composer.json")).text()).toBe("fresh\n");
      expect(await Bun.file(join(appRoot, "vendor/bin/drush")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, ".lando-drupal-scaffold-complete")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, ".lando-drupal-scaffold-copying")).exists()).toBe(false);
      expect(await Bun.file(join(stagingRoot, ".lando-drupal-stage-complete")).exists()).toBe(false);
      expect(await Bun.file(composerLog).text()).toContain("create-project drupal/recommended-project:^11");
    });
  });
});
