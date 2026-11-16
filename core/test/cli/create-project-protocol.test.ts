import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectCommand } from "../../src/recipes/builtin/create-project.ts";

const COMMAND = createProjectCommand();

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A stub Composer with the same call surface the tool uses: `create-project`
 * with `--no-install --no-scripts` writes the skeleton and its `scripts`
 * declaration, `run-script <event>` runs a hook, and `install` writes `vendor`.
 * Every call is appended to `$COMPOSER_LOG`.
 */
const fakeComposer = [
  "#!/bin/sh",
  "set -eu",
  'printf "%s\\n" "$*" >> "$COMPOSER_LOG"',
  'case "$1" in',
  "  create-project)",
  "    destination=$3",
  '    mkdir -p "$destination/app" "$destination/public"',
  '    printf "%s\\n" staged > "$destination/app/index.php"',
  '    printf "%s\\n" staged > "$destination/public/index.php"',
  '    case "$COMPOSER_HOOKS" in',
  '      both) printf "%s\\n" \'{"scripts":{"post-root-package-install":["true"],"post-create-project-cmd":["true"]}}\' > "$destination/composer.json" ;;',
  '      failing-root) printf "%s\\n" \'{"scripts":{"post-root-package-install":["false"]}}\' > "$destination/composer.json" ;;',
  '      failing-create) printf "%s\\n" \'{"scripts":{"post-create-project-cmd":["false"]}}\' > "$destination/composer.json" ;;',
  '      *) printf "%s\\n" \'{"scripts":{}}\' > "$destination/composer.json" ;;',
  "    esac",
  "    ;;",
  "  run-script)",
  '    case "$2" in',
  '      post-root-package-install) test "$COMPOSER_HOOKS" != failing-root ;;',
  '      post-create-project-cmd) test "$COMPOSER_HOOKS" != failing-create ;;',
  "      *) exit 1 ;;",
  "    esac",
  "    ;;",
  "  install)",
  "    mkdir -p vendor",
  '    printf "%s\\n" installed > vendor/autoload.php',
  '    printf "%s\\n" "{}" > composer.lock',
  "    ;;",
  "esac",
].join("\n");

/** Stands in for `php -r` in the hook probe: the event name must appear in composer.json. */
const fakePhp = ["#!/bin/sh", "set -u", 'grep -q "$LANDO_COMPOSER_EVENT" composer.json'].join("\n");

const withTempDir = async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-create-project-"));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

interface Fixture {
  readonly dir: string;
  readonly appRoot: string;
  readonly stagingParent: string;
  readonly binDir: string;
  readonly composerLog: string;
  readonly env: Readonly<Record<string, string>>;
}

const fixture = async (dir: string, hooks = "none"): Promise<Fixture> => {
  const appRoot = join(dir, "app");
  const stagingParent = join(dir, "staging");
  const binDir = join(dir, "bin");
  const composerLog = join(dir, "composer.log");
  await mkdir(appRoot, { recursive: true });
  await mkdir(binDir, { recursive: true });
  const composer = join(binDir, "composer");
  const php = join(binDir, "php");
  await writeFile(composer, fakeComposer);
  await writeFile(php, fakePhp);
  await Promise.all([chmod(composer, 0o755), chmod(php, 0o755)]);
  return {
    dir,
    appRoot,
    stagingParent,
    binDir,
    composerLog,
    env: {
      COMPOSER_HOOKS: hooks,
      COMPOSER_LOG: composerLog,
      LANDO_CREATE_PROJECT_APP_ROOT: appRoot,
      LANDO_CREATE_PROJECT_STAGING_ROOT: stagingParent,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
  };
};

/**
 * Mirrors the installed image file: the generated program is written as an
 * executable shebang script and run directly with the declared arguments.
 */
const run = async (
  cwd: string,
  env: Readonly<Record<string, string>>,
  args: ReadonlyArray<string>,
): Promise<RunResult> => {
  const program = join(cwd, "lando-create-project");
  if (!(await Bun.file(program).exists())) {
    await writeFile(program, COMMAND);
    await chmod(program, 0o755);
  }
  const proc = Bun.spawn({
    cmd: [program, ...args],
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

const calls = async (log: string): Promise<ReadonlyArray<string>> =>
  (await Bun.file(log).text()).trim().split("\n");

describe("create-project protocol", () => {
  test("runs the defined root hooks around install in Composer's order", async () => {
    await withTempDir(async (dir) => {
      const { appRoot, composerLog, env } = await fixture(dir, "both");

      const result = await run(dir, env, ["laravel/laravel"]);

      expect(result.exitCode).toBe(0);
      expect(await calls(composerLog)).toEqual([
        expect.stringMatching(
          /^create-project laravel\/laravel \S+ --no-install --no-scripts --no-interaction$/,
        ),
        "run-script post-root-package-install",
        "install --no-interaction",
        "run-script post-create-project-cmd",
      ]);
      expect(await Bun.file(join(appRoot, "composer.json")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, "vendor", "autoload.php")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, "composer.lock")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, ".lando-create-project-complete")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, ".lando-create-project-manifest")).exists()).toBe(false);
    });
  });

  test("passes the version constraint through to Composer staging", async () => {
    await withTempDir(async (dir) => {
      const { composerLog, env } = await fixture(dir);

      const result = await run(dir, env, ["typo3/cms-base-distribution", "^14"]);

      expect(result.exitCode).toBe(0);
      expect((await calls(composerLog))[0]).toMatch(
        /^create-project typo3\/cms-base-distribution \S+ \^14 --no-install --no-scripts --no-interaction$/,
      );
    });
  });

  test("succeeds when the root package defines no hooks", async () => {
    await withTempDir(async (dir) => {
      const { composerLog, env } = await fixture(dir, "none");

      const result = await run(dir, env, ["acme/hookless"]);

      expect(result.exitCode).toBe(0);
      const log = await calls(composerLog);
      expect(log.filter((line) => line.startsWith("run-script"))).toEqual([]);
      expect(log.filter((line) => line.startsWith("install"))).toEqual(["install --no-interaction"]);
    });
  });

  test.each([
    ["post-root-package-install", "failing-root"],
    ["post-create-project-cmd", "failing-create"],
  ] as const)("fails when the defined %s hook fails", async (hook, hooks) => {
    await withTempDir(async (dir) => {
      const { appRoot, env } = await fixture(dir, hooks);

      const result = await run(dir, env, ["acme/hooked"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(hook);
      expect(await Bun.file(join(appRoot, ".lando-create-project-complete")).exists()).toBe(false);
      // The promoted skeleton and its manifest stay for a resume.
      expect(await Bun.file(join(appRoot, "composer.json")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, ".lando-create-project-manifest")).exists()).toBe(true);
    });
  });

  test("--no-scripts skips both hooks and install scripts", async () => {
    await withTempDir(async (dir) => {
      const { composerLog, env } = await fixture(dir, "both");

      const result = await run(dir, env, ["--no-scripts", "acme/skipped"]);

      expect(result.exitCode).toBe(0);
      const log = await calls(composerLog);
      expect(log.filter((line) => line.startsWith("run-script"))).toEqual([]);
      expect(log.filter((line) => line.startsWith("install"))).toEqual([
        "install --no-interaction --no-scripts",
      ]);
    });
  });

  test("refuses an app root that already has composer.json", async () => {
    await withTempDir(async (dir) => {
      const { appRoot, composerLog, env } = await fixture(dir);
      await writeFile(join(appRoot, "composer.json"), "{}\n");

      const result = await run(dir, env, ["laravel/laravel"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("lando composer install");
      expect(await Bun.file(composerLog).exists()).toBe(false);
      expect(await Bun.file(join(appRoot, "composer.json")).text()).toBe("{}\n");
    });
  });

  test("refuses a completed project on rerun", async () => {
    await withTempDir(async (dir) => {
      const { appRoot, env } = await fixture(dir);
      await writeFile(join(appRoot, "composer.json"), "{}\n");
      await writeFile(join(appRoot, ".lando-create-project-complete"), "");

      const result = await run(dir, env, ["laravel/laravel"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("already published a project");
    });
  });

  test("fails fast when another create-project holds the app lock", async () => {
    await withTempDir(async (dir) => {
      const { appRoot, composerLog, env } = await fixture(dir);
      const lockDir = join(appRoot, ".lando-create-project-lock");
      await mkdir(lockDir, { recursive: true });
      await writeFile(join(lockDir, "pid"), `${process.pid}\n`);

      const result = await run(dir, env, ["laravel/laravel"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("already running");
      expect(await Bun.file(composerLog).exists()).toBe(false);
    });
  });

  test("never overwrites a Landofile or pre-existing files, and fills empty directories in place", async () => {
    await withTempDir(async (dir) => {
      const { appRoot, env } = await fixture(dir);
      await writeFile(join(appRoot, ".lando.yml"), "name: cp-fixture\n");
      await writeFile(join(appRoot, "README.md"), "user-owned\n");
      await mkdir(join(appRoot, "public"));

      const result = await run(dir, env, ["acme/mounted"]);

      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(appRoot, ".lando.yml")).text()).toBe("name: cp-fixture\n");
      expect(await Bun.file(join(appRoot, "README.md")).text()).toBe("user-owned\n");
      expect(await Bun.file(join(appRoot, "public", "index.php")).text()).toBe("staged\n");
      expect((await stat(join(appRoot, "public"))).isDirectory()).toBe(true);
      expect(await Bun.file(join(appRoot, "app", "index.php")).exists()).toBe(true);
    });
  });

  test("resumes an interrupted promotion from its durable manifest", async () => {
    await withTempDir(async (dir) => {
      const { appRoot, binDir, env } = await fixture(dir);
      const move = join(binDir, "mv");
      const realMove = join(binDir, "mv-real");
      await writeFile(
        realMove,
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
      await chmod(realMove, 0o755);
      await writeFile(
        move,
        [
          "#!/bin/sh",
          "set -eu",
          'source=; for arg in "$@"; do case "$arg" in -*) ;; *) source=$arg; break;; esac; done',
          'case "$source" in *.lando-partial) if test -n "${INTERRUPT_MARKER:-}" && ! test -e "$INTERRUPT_MARKER"; then : > "$INTERRUPT_MARKER"; exit 73; fi;; esac',
          'exec "${INTERRUPT_MV:-/bin/mv}" "$@"',
        ].join("\n"),
      );
      await chmod(move, 0o755);
      const interruptedEnv = {
        ...env,
        INTERRUPT_MARKER: join(dir, "interrupted"),
        INTERRUPT_MV: realMove,
      };

      const interrupted = await run(dir, interruptedEnv, ["acme/resumable"]);

      expect(interrupted.exitCode).not.toBe(0);
      expect(interrupted.stderr).toContain("ambiguous target during promotion");
      expect(await readFile(join(appRoot, ".lando-create-project-manifest"), "utf8")).toContain(
        "sibling-ready:app",
      );
      expect(await Bun.file(join(appRoot, ".lando-create-project-complete")).exists()).toBe(false);

      const resumed = await run(dir, env, ["acme/resumable"]);

      expect(resumed.exitCode).toBe(0);
      expect(await Bun.file(join(appRoot, "app", "index.php")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, "public", "index.php")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, "composer.json")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, ".lando-create-project-complete")).exists()).toBe(true);
      expect(await Bun.file(join(appRoot, ".lando-create-project-manifest")).exists()).toBe(false);
      expect(await Bun.file(join(appRoot, "app.lando-partial")).exists()).toBe(false);
    });
  });

  test("rejects a package name that is not vendor/package syntax", async () => {
    await withTempDir(async (dir) => {
      const { composerLog, env } = await fixture(dir);

      const result = await run(dir, env, ["laravel laravel"]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("vendor/package syntax");
      expect(await Bun.file(composerLog).exists()).toBe(false);
    });
  });
});
