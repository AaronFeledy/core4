import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DRUPAL_SCAFFOLD_COMMAND } from "../../src/recipes/builtin/drupal/render.ts";

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = async (cwd: string, env: Readonly<Record<string, string>>): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: ["sh", "-c", DRUPAL_SCAFFOLD_COMMAND],
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
  const dir = await mkdtemp(join(tmpdir(), "lando-drupal-protocol-"));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const writeFakeComposer = async (binDir: string): Promise<void> => {
  const composer = join(binDir, "composer");
  await writeFile(
    composer,
    [
      "#!/bin/sh",
      "set -eu",
      'if test "$1" = create-project; then',
      "  destination=$3",
      '  printf "%s\\n" "$destination" >> "$COMPOSER_LOG"',
      '  mkdir -p "$destination/web"',
      '  printf "%s\\n" fresh > "$destination/composer.json"',
      '  printf "%s\\n" staged > "$destination/existing.txt"',
      "else",
      "  destination=${1#--working-dir=}",
      '  mkdir -p "$destination/vendor/bin"',
      '  printf "#!/bin/sh\\nexit 0\\n" > "$destination/vendor/bin/drush"',
      '  chmod +x "$destination/vendor/bin/drush"',
      "fi",
    ].join("\n"),
  );
  await chmod(composer, 0o755);
};

const baseEnv = (
  appRoot: string,
  stagingParent: string,
  binDir: string,
  composerLog: string,
): Readonly<Record<string, string>> => ({
  COMPOSER_LOG: composerLog,
  LANDO_DRUPAL_APP_ROOT: appRoot,
  LANDO_DRUPAL_STAGING_ROOT: stagingParent,
  PATH: `${binDir}:${process.env.PATH ?? ""}`,
});

describe("Drupal scaffold copy protocol", () => {
  test("rerun preserves user-edited completed entries and pre-existing files after interruption", async () => {
    await withTempDir(async (dir) => {
      // Given
      const appRoot = join(dir, "app");
      const stagingParent = join(dir, "staging");
      const binDir = join(dir, "bin");
      const composerLog = join(dir, "composer.log");
      const moveCount = join(dir, "move-count");
      await mkdir(appRoot, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(join(appRoot, "existing.txt"), "user-owned\n");
      await writeFakeComposer(binDir);
      const mv = join(binDir, "mv");
      await writeFile(
        mv,
        [
          "#!/bin/sh",
          "set -eu",
          'case "$1" in *.lando-partial)',
          '  count=0; test ! -f "$MOVE_COUNT" || IFS= read -r count < "$MOVE_COUNT"',
          '  count=$((count + 1)); printf "%s\\n" "$count" > "$MOVE_COUNT"',
          '  test "$count" -ne 2 || exit 73',
          ";; esac",
          'exec /bin/mv "$@"',
        ].join("\n"),
      );
      await chmod(mv, 0o755);
      const env = { ...baseEnv(appRoot, stagingParent, binDir, composerLog), MOVE_COUNT: moveCount };

      // When
      const interrupted = await run(dir, env);
      await writeFile(join(appRoot, "composer.json"), "user-edited\n");
      await unlink(mv);
      const recovered = await run(dir, env);

      // Then
      expect(interrupted.exitCode).toBe(73);
      expect(recovered.exitCode).toBe(0);
      expect(await Bun.file(join(appRoot, "composer.json")).text()).toBe("user-edited\n");
      expect(await Bun.file(join(appRoot, "existing.txt")).text()).toBe("user-owned\n");
      expect(await Bun.file(join(appRoot, "vendor/bin/drush")).exists()).toBe(true);
      expect((await stat(join(appRoot, "web"))).isDirectory()).toBe(true);
    });
  });

  test("manifest-written-before-copy interleaving never removes a pre-existing path", async () => {
    await withTempDir(async (dir) => {
      // Given
      const appRoot = join(dir, "app");
      const stagingParent = join(dir, "staging");
      const binDir = join(dir, "bin");
      const composerLog = join(dir, "composer.log");
      await mkdir(appRoot, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(join(appRoot, "existing.txt"), "pre-existing\n");
      await writeFakeComposer(binDir);
      const cp = join(binDir, "cp");
      await writeFile(cp, "#!/bin/sh\nexit 74\n");
      await chmod(cp, 0o755);
      const env = baseEnv(appRoot, stagingParent, binDir, composerLog);

      // When
      const interrupted = await run(dir, env);
      await unlink(cp);
      const recovered = await run(dir, env);

      // Then
      expect(interrupted.exitCode).toBe(74);
      expect(recovered.exitCode).toBe(0);
      expect(await Bun.file(join(appRoot, "existing.txt")).text()).toBe("pre-existing\n");
    });
  });

  test("fails fast when another scaffold holds the app lock", async () => {
    await withTempDir(async (dir) => {
      // Given
      const appRoot = join(dir, "app");
      const stagingParent = join(dir, "staging");
      const binDir = join(dir, "bin");
      const composerLog = join(dir, "composer.log");
      const lockDir = join(appRoot, ".lando-drupal-scaffold-lock");
      await mkdir(lockDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(join(lockDir, "pid"), `${process.pid}\n`);
      await writeFakeComposer(binDir);

      // When
      const result = await run(dir, baseEnv(appRoot, stagingParent, binDir, composerLog));

      // Then
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("already running");
      expect(await Bun.file(composerLog).exists()).toBe(false);
    });
  });

  test("recovers a scaffold lock whose recorded process is stale", async () => {
    await withTempDir(async (dir) => {
      // Given
      const appRoot = join(dir, "app");
      const stagingParent = join(dir, "staging");
      const binDir = join(dir, "bin");
      const composerLog = join(dir, "composer.log");
      const lockDir = join(appRoot, ".lando-drupal-scaffold-lock");
      await mkdir(lockDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(join(lockDir, "pid"), "999999999\n");
      await writeFakeComposer(binDir);

      // When
      const result = await run(dir, baseEnv(appRoot, stagingParent, binDir, composerLog));

      // Then
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(lockDir, "pid")).exists()).toBe(false);
    });
  });

  test("repairs a completed marker when required outputs are missing", async () => {
    await withTempDir(async (dir) => {
      // Given
      const appRoot = join(dir, "app");
      const stagingParent = join(dir, "staging");
      const binDir = join(dir, "bin");
      const composerLog = join(dir, "composer.log");
      await mkdir(appRoot, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(join(appRoot, ".lando-drupal-scaffold-complete"), "");
      await writeFakeComposer(binDir);

      // When
      const result = await run(dir, baseEnv(appRoot, stagingParent, binDir, composerLog));

      // Then
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(appRoot, "composer.json")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, "vendor/bin/drush")).exists()).toBe(true);
      expect((await stat(join(appRoot, "web"))).isDirectory()).toBe(true);
      expect(await Bun.file(join(appRoot, ".lando-drupal-scaffold-complete")).exists()).toBe(true);
    });
  });

  test("uses distinct staging directories for separate apps", async () => {
    await withTempDir(async (dir) => {
      // Given
      const stagingParent = join(dir, "staging");
      const binDir = join(dir, "bin");
      const composerLog = join(dir, "composer.log");
      await mkdir(binDir, { recursive: true });
      await writeFakeComposer(binDir);

      // When
      const results = await Promise.all(
        ["one", "two"].map((name) => {
          const appRoot = join(dir, name);
          return run(dir, baseEnv(appRoot, stagingParent, binDir, composerLog));
        }),
      );

      // Then
      expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
      const staged = (await Bun.file(composerLog).text()).trim().split("\n");
      expect(staged).toHaveLength(2);
      expect(new Set(staged).size).toBe(2);
    });
  });
});
