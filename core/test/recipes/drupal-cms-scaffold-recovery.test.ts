import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DRUPAL_CMS_SCAFFOLD_COMMAND } from "../../src/recipes/builtin/drupal-cms/commands.ts";
import { DRUPAL_SCAFFOLD_COMMAND } from "../../src/recipes/builtin/drupal/scaffold-command.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async (options: { command?: string; killDuringPromotion?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "lando-drupal-cms-recovery-"));
  roots.push(root);
  const appRoot = join(root, "app");
  const stagingRoot = join(root, "staging");
  const bin = join(root, "bin");
  const failOnce = join(root, "copy-failed-once");
  const killDuringPromotion = join(root, "kill-during-promotion");
  await Promise.all([
    mkdir(join(appRoot, "vendor"), { recursive: true }),
    mkdir(join(appRoot, "web"), { recursive: true }),
    mkdir(stagingRoot, { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);
  const composer = join(bin, "composer");
  await writeFile(
    composer,
    [
      "#!/bin/sh",
      "set -eu",
      'case "$1" in --working-dir=*) exit 0;; create-project) target=$3;; *) exit 2;; esac',
      'mkdir -p "$target/vendor/bin" "$target/web/core/lib"',
      'printf "#!/bin/sh\\n" > "$target/vendor/bin/drush"',
      'chmod +x "$target/vendor/bin/drush"',
      'printf "{}\\n" > "$target/composer.json"',
      'printf "early\\n" > "$target/web/early.txt"',
      'printf "late\\n" > "$target/web/core/lib/Drupal.php"',
    ].join("\n"),
  );
  const copy = join(bin, "cp");
  await writeFile(
    copy,
    [
      "#!/bin/sh",
      "set -eu",
      'case "$2" in',
      '  */web/.) if ! test -e "$LANDO_TEST_COPY_FAILED"; then touch "$LANDO_TEST_COPY_FAILED"; mkdir -p "$3"; /bin/cp "$2/early.txt" "$3/"; exit 42; fi;;',
      "esac",
      'exec /bin/cp "$@"',
    ].join("\n"),
  );
  const movePrimitive = join(bin, "mv-real");
  await writeFile(
    movePrimitive,
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
  const move = join(bin, "mv");
  await writeFile(
    move,
    [
      "#!/bin/sh",
      "set -eu",
      'source=; for arg in "$@"; do case "$arg" in -*) ;; *) source=$arg; break;; esac; done',
      'case "$source" in',
      '  */.lando-partial/*) if test -e "$LANDO_TEST_KILL_PROMOTION"; then /bin/mv "$@"; rm -f "$LANDO_TEST_KILL_PROMOTION"; kill -KILL "$PPID"; exit 137; fi;;',
      "esac",
      'exec "$LANDO_TEST_MV" "$@"',
    ].join("\n"),
  );
  await Promise.all([
    chmod(composer, 0o755),
    chmod(copy, 0o755),
    chmod(movePrimitive, 0o755),
    chmod(move, 0o755),
  ]);
  if (options.killDuringPromotion) await writeFile(killDuringPromotion, "");
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    LANDO_DRUPAL_APP_ROOT: appRoot,
    LANDO_DRUPAL_CMS_APP_ROOT: appRoot,
    LANDO_DRUPAL_STAGING_ROOT: stagingRoot,
    LANDO_DRUPAL_CMS_STAGING_ROOT: stagingRoot,
    LANDO_TEST_COPY_FAILED: failOnce,
    LANDO_TEST_KILL_PROMOTION: killDuringPromotion,
    LANDO_TEST_MV: movePrimitive,
  };
  const run = () => Bun.spawnSync(["/bin/sh", "-c", options.command ?? DRUPAL_CMS_SCAFFOLD_COMMAND], { env });
  return { appRoot, failOnce, run };
};

describe("Drupal CMS scaffold interruption recovery", () => {
  test("retries an interrupted copy into existing empty targets without accepting a partial web tree", async () => {
    const { appRoot, run } = await fixture();

    const first = run();

    expect(first.exitCode).not.toBe(0);
    expect(await readFile(join(appRoot, ".lando-drupal-cms-scaffold-manifest"), "utf8")).toContain(
      "nested-incomplete:web",
    );
    expect(await Bun.file(join(appRoot, "web", "early.txt")).exists()).toBe(false);
    expect(await Bun.file(join(appRoot, "web", ".lando-partial", "early.txt")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(false);

    const second = run();

    expect(second.exitCode).toBe(0);
    expect(await Bun.file(join(appRoot, "web", "early.txt")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, "web", "core", "lib", "Drupal.php")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, "vendor", "bin", "drush")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-manifest")).exists()).toBe(false);
    expect(await Bun.file(join(appRoot, "web", ".lando-partial")).exists()).toBe(false);
  });

  test("retries an interrupted copy with the plain Drupal scaffold command", async () => {
    const { appRoot, run } = await fixture({ command: DRUPAL_SCAFFOLD_COMMAND });

    const first = run();
    expect(first.exitCode).not.toBe(0);
    const retry = run();
    expect(retry.exitCode).toBe(0);
    expect(await Bun.file(join(appRoot, "web", "core", "lib", "Drupal.php")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, ".lando-drupal-scaffold-complete")).exists()).toBe(true);
  });

  test("recovers after SIGKILL during nested promotion without overwriting a promoted child", async () => {
    const { appRoot, failOnce, run } = await fixture({ killDuringPromotion: true });
    await writeFile(failOnce, "");

    const interrupted = run();

    expect(interrupted.exitCode).not.toBe(0);
    expect(await readFile(join(appRoot, ".lando-drupal-cms-scaffold-manifest"), "utf8")).toContain(
      "nested-ready:vendor",
    );
    expect(await Bun.file(join(appRoot, "vendor", "bin", "drush")).exists()).toBe(true);

    const retry = run();

    expect(retry.exitCode).toBe(0);
    expect(await Bun.file(join(appRoot, "web", "early.txt")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, "web", "core", "lib", "Drupal.php")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, "web", ".lando-partial")).exists()).toBe(false);
    expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(true);
  });

  test("accepts an absent owned partial after nested-complete cleanup", async () => {
    const { appRoot, failOnce, run } = await fixture();
    await Promise.all([
      writeFile(join(appRoot, ".lando-drupal-cms-scaffold-manifest"), "nested-complete:web\n"),
      writeFile(failOnce, ""),
    ]);

    const retry = run();

    expect(retry.exitCode).toBe(0);
    expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(true);
  });

  test("preserves and rejects a symlink collision during nested-ready recovery", async () => {
    const { appRoot, failOnce, run } = await fixture();
    const partial = join(appRoot, "web", ".lando-partial");
    const outside = join(appRoot, "outside.txt");
    await mkdir(partial, { recursive: true });
    await Promise.all([
      writeFile(join(partial, "early.txt"), "scaffold\n"),
      writeFile(outside, "user\n"),
      writeFile(join(appRoot, ".lando-drupal-cms-scaffold-manifest"), "nested-ready:web\n"),
      writeFile(failOnce, ""),
    ]);
    await symlink(outside, join(appRoot, "web", "early.txt"));

    const retry = run();

    expect(retry.exitCode).not.toBe(0);
    expect(await readFile(outside, "utf8")).toBe("user\n");
    expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(false);
  });

  test("fails closed on a legacy incomplete manifest with direct-copy contents", async () => {
    const { appRoot, failOnce, run } = await fixture();
    const ambiguous = join(appRoot, "web", "possibly-partial.txt");
    await Promise.all([
      writeFile(ambiguous, "preserve\n"),
      writeFile(join(appRoot, ".lando-drupal-cms-scaffold-manifest"), "incomplete:web\n"),
      writeFile(failOnce, ""),
    ]);

    const retry = run();

    expect(retry.exitCode).not.toBe(0);
    expect(await readFile(ambiguous, "utf8")).toBe("preserve\n");
    expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(false);
  });

  test("preserves and rejects user content added beside an interrupted nested partial", async () => {
    const { appRoot, run } = await fixture();
    expect(run().exitCode).not.toBe(0);
    const userFile = join(appRoot, "web", "user-created.txt");
    await writeFile(userFile, "keep me\n");

    const retry = run();

    expect(retry.exitCode).not.toBe(0);
    expect(await readFile(userFile, "utf8")).toBe("keep me\n");
    expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(false);
  });

  test("preserves an ambiguous legacy sibling partial", async () => {
    const { appRoot, failOnce, run } = await fixture();
    const partial = join(appRoot, "web.lando-partial");
    await mkdir(partial, { recursive: true });
    await Promise.all([
      writeFile(join(partial, "user.txt"), "preserve\n"),
      writeFile(join(appRoot, ".lando-drupal-cms-scaffold-manifest"), "incomplete:web\n"),
      writeFile(failOnce, ""),
    ]);

    const retry = run();

    expect(retry.exitCode).not.toBe(0);
    expect((await lstat(partial)).isDirectory()).toBe(true);
    expect(await readFile(join(partial, "user.txt"), "utf8")).toBe("preserve\n");
  });

  test.each(["nonempty", "symlink"] as const)(
    "preserves and rejects a %s nested partial after nested-complete",
    async (kind) => {
      const { appRoot, failOnce, run } = await fixture();
      const partial = join(appRoot, "web", ".lando-partial");
      if (kind === "nonempty") {
        await mkdir(partial, { recursive: true });
        await writeFile(join(partial, "user.txt"), "preserve\n");
      } else {
        const outside = join(appRoot, "outside-partial");
        await mkdir(outside, { recursive: true });
        await symlink(outside, partial);
      }
      await Promise.all([
        writeFile(join(appRoot, ".lando-drupal-cms-scaffold-manifest"), "nested-complete:web\n"),
        writeFile(failOnce, ""),
      ]);

      const retry = run();

      expect(retry.exitCode).not.toBe(0);
      expect((await lstat(partial)).isDirectory() || (await lstat(partial)).isSymbolicLink()).toBe(true);
      expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(false);
    },
  );

  test.each(["sibling-incomplete", "nested-incomplete"] as const)(
    "preserves an unmarked reserved path after a %s crash gap",
    async (state) => {
      const { appRoot, failOnce, run } = await fixture();
      const partial =
        state === "sibling-incomplete"
          ? join(appRoot, "composer.json.lando-partial")
          : join(appRoot, "web", ".lando-partial");
      await mkdir(partial, { recursive: true });
      await Promise.all([
        writeFile(join(partial, "user.txt"), "preserve\n"),
        writeFile(
          join(appRoot, ".lando-drupal-cms-scaffold-manifest"),
          `${state}:${state === "sibling-incomplete" ? "composer.json" : "web"}\n`,
        ),
        writeFile(failOnce, ""),
      ]);

      const retry = run();

      expect(retry.exitCode).not.toBe(0);
      expect(await readFile(join(partial, "user.txt"), "utf8")).toBe("preserve\n");
    },
  );

  test.each(["nested-complete", "complete"] as const)(
    "finishes exact ownership-marker cleanup from durable %s state",
    async (state) => {
      const { appRoot, failOnce, run } = await fixture();
      const entry = state === "nested-complete" ? "web" : "composer.json";
      const marker =
        state === "nested-complete"
          ? join(appRoot, "web", ".lando-partial", ".lando-owned")
          : join(appRoot, "composer.json.lando-partial.lando-owner", "version");
      await mkdir(join(marker, ".."), { recursive: true });
      await Promise.all([
        writeFile(marker, "v1\n"),
        writeFile(join(appRoot, ".lando-drupal-cms-scaffold-manifest"), `${state}:${entry}\n`),
        writeFile(failOnce, ""),
      ]);

      const retry = run();

      expect(retry.exitCode).toBe(0);
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(await Bun.file(join(appRoot, ".lando-drupal-cms-scaffold-complete")).exists()).toBe(true);
    },
  );
});
