import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DRUPAL_CMS_SCAFFOLD_COMMAND } from "../../src/recipes/builtin/drupal-cms/commands.ts";
import { DRUPAL_SCAFFOLD_COMMAND } from "../../src/recipes/builtin/drupal/scaffold-command.ts";

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const run = async (
  cwd: string,
  env: Readonly<Record<string, string>>,
  command = DRUPAL_SCAFFOLD_COMMAND,
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: ["sh", "-c", command],
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
      '  mkdir -p "$destination/web" "$destination/vendor/bin"',
      '  printf "#!/bin/sh\\nexit 0\\n" > "$destination/vendor/bin/drush"',
      '  chmod +x "$destination/vendor/bin/drush"',
      '  printf "%s\\n" fresh > "$destination/composer.json"',
      '  printf "%s\\n" staged > "$destination/existing.txt"',
      '  if test "${CLASSIFICATION_FIXTURES:-0}" = 1; then',
      '    : > "$destination/zero.txt"',
      '    printf "%s\\n" staged > "$destination/broken.txt"',
      '    mkdir -p "$destination/existing-dir"',
      '    printf "%s\\n" staged > "$destination/existing-dir/staged.txt"',
      '    mkdir -p "$destination/newline-dir"',
      '    printf "%s\\n" staged > "$destination/newline-dir/staged.txt"',
      "  fi",
      "else",
      "  destination=${1#--working-dir=}",
      '  mkdir -p "$destination/vendor/bin"',
      '  printf "#!/bin/sh\\nexit 0\\n" > "$destination/vendor/bin/drush"',
      '  chmod +x "$destination/vendor/bin/drush"',
      "fi",
    ].join("\n"),
  );
  const mvPrimitive = join(binDir, "mv-real");
  await writeFile(
    mvPrimitive,
    [
      "#!/bin/sh",
      "set -eu",
      'if test "${1:-}" = -T && test "${2:-}" = -n; then',
      "  source=$3; destination=$4",
      '  if test -e "$destination" || test -L "$destination"; then exit 0; fi',
      '  exec /bin/mv "$source" "$destination"',
      "fi",
      'exec /bin/mv "$@"',
    ].join("\n"),
  );
  const mv = join(binDir, "mv");
  await writeFile(mv, '#!/bin/sh\nexec "$LANDO_TEST_MV" "$@"\n');
  await Promise.all([chmod(composer, 0o755), chmod(mvPrimitive, 0o755), chmod(mv, 0o755)]);
};

const baseEnv = (
  appRoot: string,
  stagingParent: string,
  binDir: string,
  composerLog: string,
): Readonly<Record<string, string>> => ({
  COMPOSER_LOG: composerLog,
  LANDO_DRUPAL_APP_ROOT: appRoot,
  LANDO_DRUPAL_CMS_APP_ROOT: appRoot,
  LANDO_DRUPAL_STAGING_ROOT: stagingParent,
  LANDO_DRUPAL_CMS_STAGING_ROOT: stagingParent,
  LANDO_TEST_MV: join(binDir, "mv-real"),
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
          'source=; for arg in "$@"; do case "$arg" in -*) ;; *) source=$arg; break;; esac; done',
          'case "$source" in *.lando-partial)',
          '  count=0; test ! -f "$MOVE_COUNT" || IFS= read -r count < "$MOVE_COUNT"',
          '  count=$((count + 1)); printf "%s\\n" "$count" > "$MOVE_COUNT"',
          '  test "$count" -ne 2 || exit 73',
          ";; esac",
          'exec "$LANDO_TEST_MV" "$@"',
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
      expect(interrupted.exitCode).not.toBe(0);
      expect(recovered.exitCode).toBe(0);
      expect(await Bun.file(join(appRoot, "composer.json")).text()).toBe("user-edited\n");
      expect(await Bun.file(join(appRoot, "existing.txt")).text()).toBe("user-owned\n");
      expect(await Bun.file(join(appRoot, "vendor/bin/drush")).exists()).toBe(true);
      expect((await stat(join(appRoot, "web"))).isDirectory()).toBe(true);
    });
  });

  test.each([
    ["Drupal", DRUPAL_SCAFFOLD_COMMAND],
    ["Drupal CMS", DRUPAL_CMS_SCAFFOLD_COMMAND],
  ] as const)(
    "%s manifest snapshot preserves a pre-existing path across an earlier copy failure",
    async (_, command) => {
      await withTempDir(async (dir) => {
        const appRoot = join(dir, "app");
        const stagingParent = join(dir, "staging");
        const binDir = join(dir, "bin");
        const composerLog = join(dir, "composer.log");
        await mkdir(appRoot, { recursive: true });
        await mkdir(binDir, { recursive: true });
        await writeFile(join(appRoot, "existing.txt"), "pre-existing\n");
        await writeFile(join(appRoot, "zero.txt"), "");
        await symlink("missing-target", join(appRoot, "broken.txt"));
        await mkdir(join(appRoot, "existing-dir"));
        await writeFile(join(appRoot, "existing-dir/user.txt"), "user-owned\n");
        if (process.platform !== "win32") {
          await mkdir(join(appRoot, "newline-dir"));
          await writeFile(join(appRoot, "newline-dir", "\n"), "user-owned\n");
        }
        await writeFakeComposer(binDir);
        const cp = join(binDir, "cp");
        await writeFile(cp, "#!/bin/sh\nexit 74\n");
        await chmod(cp, 0o755);
        const env = {
          ...baseEnv(appRoot, stagingParent, binDir, composerLog),
          CLASSIFICATION_FIXTURES: "1",
        };

        const interrupted = await run(dir, env, command);
        await unlink(cp);
        const recovered = await run(dir, env, command);

        expect(interrupted.exitCode).toBe(74);
        expect(recovered.exitCode).toBe(0);
        expect(await Bun.file(join(appRoot, "existing.txt")).text()).toBe("pre-existing\n");
        expect((await lstat(join(appRoot, "zero.txt"))).size).toBe(0);
        expect((await lstat(join(appRoot, "broken.txt"))).isSymbolicLink()).toBe(true);
        expect(await readlink(join(appRoot, "broken.txt"))).toBe("missing-target");
        expect(await Bun.file(join(appRoot, "existing-dir/user.txt")).text()).toBe("user-owned\n");
        expect(await Bun.file(join(appRoot, "existing-dir/staged.txt")).exists()).toBe(false);
        if (process.platform !== "win32") {
          expect(await Bun.file(join(appRoot, "newline-dir", "\n")).text()).toBe("user-owned\n");
          expect(await Bun.file(join(appRoot, "newline-dir/staged.txt")).exists()).toBe(false);
        }
      });
    },
  );

  test.each([
    ["Drupal", DRUPAL_SCAFFOLD_COMMAND],
    ["Drupal CMS", DRUPAL_CMS_SCAFFOLD_COMMAND],
  ] as const)("%s fails closed when a target appears after the manifest snapshot", async (_, command) => {
    await withTempDir(async (dir) => {
      const appRoot = join(dir, "app");
      const stagingParent = join(dir, "staging");
      const binDir = join(dir, "bin");
      const composerLog = join(dir, "composer.log");
      const injectedTarget = join(appRoot, "existing.txt");
      await mkdir(appRoot, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFakeComposer(binDir);
      const cp = join(binDir, "cp");
      await writeFile(
        cp,
        [
          "#!/bin/sh",
          "set -eu",
          'if test ! -e "$INJECT_MARKER"; then',
          '  : > "$INJECT_MARKER"',
          '  if test "$INJECT_KIND" = directory; then',
          '    mkdir "$INJECT_TARGET"',
          '    printf "%s\n" injected > "$INJECT_TARGET/user.txt"',
          "  else",
          '    printf "%s\n" injected > "$INJECT_TARGET"',
          "  fi",
          "fi",
          'exec /bin/cp "$@"',
        ].join("\n"),
      );
      await chmod(cp, 0o755);
      const env = {
        ...baseEnv(appRoot, stagingParent, binDir, composerLog),
        INJECT_KIND: "file",
        INJECT_MARKER: join(dir, "injected.marker"),
        INJECT_TARGET: injectedTarget,
      };

      const interrupted = await run(dir, env, command);

      expect(interrupted.exitCode).not.toBe(0);
      expect(interrupted.stderr).toContain("ambiguous target after manifest snapshot");
      expect(await Bun.file(injectedTarget).text()).toBe("injected\n");
    });
  });

  test.each([
    ["Drupal", "file", DRUPAL_SCAFFOLD_COMMAND],
    ["Drupal", "directory", DRUPAL_SCAFFOLD_COMMAND],
    ["Drupal CMS", "file", DRUPAL_CMS_SCAFFOLD_COMMAND],
    ["Drupal CMS", "directory", DRUPAL_CMS_SCAFFOLD_COMMAND],
  ] as const)(
    "%s never overwrites a %s target injected during its own copy",
    async (_, targetKind, command) => {
      await withTempDir(async (dir) => {
        const appRoot = join(dir, "app");
        const stagingParent = join(dir, "staging");
        const binDir = join(dir, "bin");
        const composerLog = join(dir, "composer.log");
        const injectedTarget = join(appRoot, "composer.json");
        await mkdir(appRoot, { recursive: true });
        await mkdir(binDir, { recursive: true });
        await writeFakeComposer(binDir);
        const cp = join(binDir, "cp");
        await writeFile(
          cp,
          [
            "#!/bin/sh",
            "set -eu",
            'if test ! -e "$INJECT_MARKER"; then',
            '  : > "$INJECT_MARKER"',
            '  if test "$INJECT_KIND" = directory; then',
            '    mkdir "$INJECT_TARGET"',
            '    printf "%s\n" injected > "$INJECT_TARGET/user.txt"',
            "  else",
            '    printf "%s\n" injected > "$INJECT_TARGET"',
            "  fi",
            "fi",
            'exec /bin/cp "$@"',
          ].join("\n"),
        );
        await chmod(cp, 0o755);
        const env = {
          ...baseEnv(appRoot, stagingParent, binDir, composerLog),
          INJECT_KIND: targetKind,
          INJECT_MARKER: join(dir, "injected-current.marker"),
          INJECT_TARGET: injectedTarget,
        };

        const result = await run(dir, env, command);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("ambiguous target during promotion");
        if (targetKind === "directory") {
          expect(await Bun.file(join(injectedTarget, "user.txt")).text()).toBe("injected\n");
        } else {
          expect(await Bun.file(injectedTarget).text()).toBe("injected\n");
        }
        expect(await Bun.file(`${injectedTarget}.lando-partial`).exists()).toBe(true);
        expect(await Bun.file(join(appRoot, ".lando-drupal-scaffold-complete")).exists()).toBe(false);
        expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(false);
      });
    },
  );

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

  test("populates empty mounted cache-volume and working-dir targets instead of skipping them", async () => {
    await withTempDir(async (dir) => {
      // Given: /app/vendor (a mounted cache volume) and /app/web (the container
      // working_dir) already exist as empty directories before scaffolding, as
      // they do once the appserver has started.
      const appRoot = join(dir, "app");
      const stagingParent = join(dir, "staging");
      const binDir = join(dir, "bin");
      const composerLog = join(dir, "composer.log");
      await mkdir(join(appRoot, "vendor"), { recursive: true });
      await mkdir(join(appRoot, "web"), { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFakeComposer(binDir);

      // When
      const result = await run(dir, baseEnv(appRoot, stagingParent, binDir, composerLog));

      // Then
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(appRoot, "vendor/bin/drush")).exists()).toBe(true);
      expect((await stat(join(appRoot, "vendor/bin/drush"))).mode & 0o111).not.toBe(0);
      expect((await stat(join(appRoot, "web"))).isDirectory()).toBe(true);
      expect(await Bun.file(join(appRoot, "composer.json")).exists()).toBe(true);
    });
  });
});
