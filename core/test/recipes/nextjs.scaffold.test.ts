import { afterEach, test as bunTest, expect } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEXTJS_SCAFFOLD_COMMAND } from "../../src/recipes/builtin/nextjs/scaffold-command.ts";

// The real helper runs in Linux containers and requires /bin/sh and GNU cp -T.
const test = bunTest.skipIf(process.platform !== "linux");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tree = async (path: string): Promise<unknown> => {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return { link: await readlink(path), inode: stat.ino };
  if (stat.isDirectory()) {
    const entries = await readdir(path);
    return {
      inode: stat.ino,
      entries: await Promise.all(entries.sort().map(async (entry) => [entry, await tree(join(path, entry))])),
    };
  }
  return { inode: stat.ino, content: await Bun.file(path).text() };
};

const fixture = async (mode = "success") => {
  const root = await mkdtemp(join(tmpdir(), "lando-nextjs-scaffold-"));
  roots.push(root);
  const app = join(root, "app");
  const stage = join(root, "stage");
  const bin = join(root, "bin");
  const log = join(root, "calls");
  const contention = join(root, "contention");
  await Promise.all([mkdir(app), mkdir(stage), mkdir(bin)]);
  await writeFile(join(app, ".lando.yml"), "name: keep-me\n");
  await writeFile(join(app, "user.txt"), "untouched\n");
  for (const mount of [".git", "node_modules", "vendor", "tmp"]) {
    await mkdir(join(app, mount));
    await writeFile(join(app, mount, "keep"), mount);
  }
  const executables = {
    npx: [
      "#!/bin/sh",
      "set -eu",
      'printf "%s\\n" "$@" > "$TEST_CALLS"',
      'test "$1" = --yes && test "$2" = create-next-app@16.4.0',
      "target=$3; shift 3",
      'test "$(basename "$target")" = nextjs-app',
      'test "$*" = "--yes --skip-install --disable-git --use-npm --ts --eslint --no-tailwind --app --no-src-dir --import-alias @/* --no-react-compiler --empty"',
      'case "$target" in "$LANDO_NEXTJS_APP_ROOT"/*) exit 91;; esac',
      'if test "$TEST_MODE" = contend-generation; then if /bin/sh -c "$TEST_SCAFFOLD_COMMAND" > "$TEST_CONTENTION_FILE" 2>&1; then exit 92; fi; fi',
      'mkdir -p "$target/app" "$target/.git" "$target/node_modules"',
      'printf "generated\\n" > "$target/app/page.tsx"',
      'printf "{\\"name\\":\\"nextjs-app\\"}\\n" > "$target/package.json"',
      'printf "ignore\\n" > "$target/.gitignore"',
      'printf "excluded\\n" > "$target/.git/staged"',
      'printf "excluded\\n" > "$target/node_modules/staged"',
      'case "$TEST_MODE" in upstream-fail) exit 42;; signal) kill -TERM "$PPID"; exit 1;; protected) touch "$target/.lando.yml";; missing-app) rmdir "$target/app" 2>/dev/null || rm "$target/app/page.tsx"; rmdir "$target/app";; esac',
    ].join("\n"),
    npm: [
      "#!/bin/sh",
      "set -eu",
      'test "$*" = install && test "$PWD" = "$LANDO_NEXTJS_APP_ROOT"',
      'printf "npm:%s\\n" "$PWD" >> "$TEST_CALLS"',
      'if test "$TEST_MODE" = contend-install; then if /bin/sh -c "$TEST_SCAFFOLD_COMMAND" > "$TEST_CONTENTION_FILE" 2>&1; then exit 92; fi; fi',
      'test "$TEST_MODE" != install-fail || exit 43',
      'printf "installed\\n" > node_modules/installed',
    ].join("\n"),
    cp: [
      "#!/bin/sh",
      'if test "$TEST_MODE" = copy-fail; then case "$5" in */package.json) exit 44;; esac; fi',
      'case "$5" in */app) case "$TEST_MODE" in late-package) printf "injected\\n" > "$LANDO_NEXTJS_APP_ROOT/package.json";; late-directory) mkdir "$LANDO_NEXTJS_APP_ROOT/.gitignore"; printf "user\\n" > "$LANDO_NEXTJS_APP_ROOT/.gitignore/keep";; esac;; esac',
      'exec /bin/cp "$@"',
    ].join("\n"),
  };
  for (const [name, script] of Object.entries(executables)) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  const run = (stagingParent = stage) =>
    Bun.spawnSync(["/bin/sh", "-c", NEXTJS_SCAFFOLD_COMMAND], {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        LANDO_NEXTJS_APP_ROOT: app,
        LANDO_NEXTJS_STAGING_ROOT: stagingParent,
        TEST_MODE: mode,
        TEST_CALLS: log,
        TEST_SCAFFOLD_COMMAND: NEXTJS_SCAFFOLD_COMMAND,
        TEST_CONTENTION_FILE: contention,
      },
    });
  return { app, stage, log, contention, run };
};

test("publishes the pinned starter and installs in the app when mounted paths already exist", async () => {
  // Given a Landofile and populated mount directories.
  const { app, stage, log, run } = await fixture();
  const preserved = [".lando.yml", ".git", "vendor", "tmp", "user.txt"];
  const before = await Promise.all(preserved.map((entry) => tree(join(app, entry))));
  const modulesInode = (await lstat(join(app, "node_modules"))).ino;
  // When the real command executes against narrow offline package-manager executables.
  const result = run();
  // Then it publishes sources, excludes stage dependencies/git, and preserves mounted paths.
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(join(app, "app/page.tsx")).text()).toBe("generated\n");
  expect(await Bun.file(join(app, "package.json")).json()).toEqual({ name: "nextjs-app" });
  expect(await Bun.file(join(app, ".gitignore")).text()).toBe("ignore\n");
  expect(await Promise.all(preserved.map((entry) => tree(join(app, entry))))).toEqual(before);
  expect((await lstat(join(app, "node_modules"))).ino).toBe(modulesInode);
  expect((await readdir(join(app, "node_modules"))).sort()).toEqual(["installed", "keep"]);
  expect(await Bun.file(log).text()).toContain(`npm:${app}\n`);
  expect(await readdir(stage)).toEqual([]);
});

test.each(["file", "directory", "symlink", "dangling-symlink"])(
  "publishes nothing when a late publication target is a %s",
  async (kind) => {
    // Given a conflicting hidden target encountered after source entries in preflight.
    const { app, stage, log, run } = await fixture();
    const target = join(app, ".gitignore");
    switch (kind) {
      case "file":
        await writeFile(target, "original");
        break;
      case "directory":
        await mkdir(target);
        break;
      case "symlink":
        await symlink(join(app, "user.txt"), target);
        break;
      case "dangling-symlink":
        await symlink(join(app, "absent"), target);
        break;
      default:
        throw new TypeError(`Unknown fixture kind: ${kind}`);
    }
    const before = await tree(app);
    // When preflight sees the collision.
    const result = run();
    // Then no source or user path changes and installation never starts.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(".gitignore");
    expect(result.stderr.toString()).toContain("lando nextjs-scaffold");
    expect(await tree(app)).toEqual(before);
    expect(await Bun.file(log).text()).not.toContain("npm:");
    expect(await readdir(stage)).toEqual([]);
  },
);

test.each(["upstream-fail", "signal", "protected", "missing-app"])(
  "leaves the app untouched and cleans owned staging when generation encounters %s",
  async (mode) => {
    // Given a generation failure and unrelated temporary content.
    const { app, stage, run } = await fixture(mode);
    await writeFile(join(stage, "unrelated"), "keep");
    const before = await tree(app);
    // When the real command runs.
    const result = run();
    // Then failure never publishes sources or removes unrelated temporary content.
    expect(result.exitCode).not.toBe(0);
    expect(await tree(app)).toEqual(before);
    expect(await readdir(stage)).toEqual(["unrelated"]);
    expect(await Bun.file(join(stage, "unrelated")).text()).toBe("keep");
  },
);

test("retains generated sources when npm install fails", async () => {
  // Given an unavailable dependency installation boundary.
  const { app, stage, run } = await fixture("install-fail");
  // When generation and publication succeed but installation fails.
  const result = run();
  // Then users can rerun installation without regenerating their app.
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("lando npm install");
  expect(await Bun.file(join(app, "app/page.tsx")).text()).toBe("generated\n");
  expect(await Bun.file(join(app, "package.json")).json()).toEqual({ name: "nextjs-app" });
  expect(await readdir(stage)).toEqual([]);
});

test("refuses repeat scaffolding without network or file changes", async () => {
  // Given a scaffolded app with a subsequent user edit.
  const { app, stage, log, run } = await fixture();
  expect(run().exitCode).toBe(0);
  await writeFile(join(app, "app/page.tsx"), "user edit\n");
  const before = await tree(app);
  const calls = await Bun.file(log).text();
  // When scaffolding is requested again.
  const result = run();
  // Then it refuses rather than overwriting or calling package managers again.
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("package.json");
  expect(await tree(app)).toEqual(before);
  expect(await Bun.file(log).text()).toBe(calls);
  expect(await readdir(stage)).toEqual([]);
});

test("reports publication failures without deleting user paths", async () => {
  // Given a failing copy boundary.
  const { app, stage, run } = await fixture("copy-fail");
  const originalEntries = await readdir(app);
  const before = await Promise.all(originalEntries.map((entry) => tree(join(app, entry))));
  // When publication fails.
  const result = run();
  // Then the partial-copy diagnostic is actionable and temporary staging is cleaned.
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("partial sources were retained");
  expect(await Promise.all(originalEntries.map((entry) => tree(join(app, entry))))).toEqual(before);
  expect(await Bun.file(join(app, "app/page.tsx")).text()).toBe("generated\n");
  expect(await Bun.file(join(app, "package.json")).exists()).toBe(false);
  expect(await readdir(stage)).toEqual([]);
});

test("rejects staging inside the app even through a symlink", async () => {
  // Given a temporary-directory alias pointing into a mounted app path.
  const { app, stage, log, run } = await fixture();
  const alias = join(stage, "alias");
  await symlink(join(app, "tmp"), alias);
  const before = await tree(app);
  // When staging would occur through that alias.
  const result = run(alias);
  // Then rejection precedes network access or any app mutation.
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("outside the app root");
  expect(await tree(app)).toEqual(before);
  expect(await Bun.file(log).exists()).toBe(false);
});

test("refuses a dangling package.json link before invoking package managers", async () => {
  // Given a user-owned package.json symlink whose target does not exist.
  const { app, log, run } = await fixture();
  await symlink(join(app, "absent"), join(app, "package.json"));
  const before = await tree(app);
  // When scaffolding is requested.
  const result = run();
  // Then the link is preserved and generation never starts.
  expect(result.exitCode).not.toBe(0);
  expect(await tree(app)).toEqual(before);
  expect(await Bun.file(log).exists()).toBe(false);
});

test("refuses lock contention without touching the other invocation's lock", async () => {
  // Given a lock held by another scaffold invocation.
  const { app, stage, log, run } = await fixture();
  await mkdir(join(app, ".lando-nextjs-scaffold-lock"));
  const before = await tree(app);
  // When another invocation requests scaffolding.
  const result = run();
  // Then it refuses before generation and leaves the owned lock untouched.
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(".lando-nextjs-scaffold-lock");
  expect(await tree(app)).toEqual(before);
  expect(await Bun.file(log).exists()).toBe(false);
  expect(await readdir(stage)).toEqual([]);
});

test.each(["late-package", "late-directory"])(
  "stops publication and installation when %s appears after preflight",
  async (mode) => {
    // Given a real copy boundary that introduces a later target after preflight.
    const { app, stage, log, run } = await fixture(mode);
    // When the command reaches the newly occupied target.
    const result = run();
    // Then user contents survive, no package is executed, and the lock is released.
    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(join(app, "app/page.tsx")).text()).toBe("generated\n");
    const target = mode === "late-package" ? "package.json" : ".gitignore/keep";
    expect(await Bun.file(join(app, target)).text()).toBe(mode === "late-package" ? "injected\n" : "user\n");
    expect(await Bun.file(log).text()).not.toContain("npm:");
    expect(await readdir(app)).not.toContain(".lando-nextjs-scaffold-lock");
    expect(await readdir(stage)).toEqual([]);
  },
);

test.each(["contend-generation", "contend-install"])(
  "holds the exclusive lock when a second real invocation attempts %s",
  async (mode) => {
    // Given a second invocation launched while the first is generating or installing.
    const { app, stage, contention, run } = await fixture(mode);
    // When the outer scaffold runs through its real subprocess boundaries.
    const result = run();
    // Then the second invocation refuses the lock, and the owner completes normally.
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(contention).text()).toContain(".lando-nextjs-scaffold-lock");
    expect(await Bun.file(join(app, "node_modules/installed")).text()).toBe("installed\n");
    expect(await readdir(app)).not.toContain(".lando-nextjs-scaffold-lock");
    expect(await readdir(stage)).toEqual([]);
  },
);
