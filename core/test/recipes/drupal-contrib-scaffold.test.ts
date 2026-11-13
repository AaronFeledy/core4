import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drupalContribScaffoldCommand } from "../../src/recipes/builtin/drupal-contrib/commands.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fakeComposer = [
  "#!/bin/sh",
  "set -eu",
  "log=${LANDO_TEST_COMPOSER_LOG:-/dev/null}",
  'printf "%s\\n" "$*" >> "$log"',
  'working=; case "${1:-}" in --working-dir=*) working=${1#--working-dir=}; shift;; esac',
  "command=${1:-}",
  "shift || true",
  "target=$working",
  "package=; dest=",
  'for arg in "$@"; do',
  '  case "$arg" in',
  "    --*) continue;;",
  "    drupal/*) package=$arg;;",
  '    *) if test -z "$dest" && test "$command" = create-project; then dest=$arg; fi;;',
  "  esac",
  "done",
  'case "$command" in',
  "  create-project)",
  '    test -n "$dest"',
  '    mkdir -p "$dest/vendor/bin" "$dest/web/core/lib" "$dest/web/modules" "$dest/web/sites/default"',
  '    printf "%s\\n" "{"name":"lando/drupal-contrib-site","require":{"drupal/core-recommended":"^11"}}" > "$dest/composer.json"',
  '    printf "#!/bin/sh\\n" > "$dest/vendor/bin/drush"',
  '    printf "#!/bin/sh\\n" > "$dest/vendor/bin/phpunit"',
  '    printf "#!/bin/sh\\n" > "$dest/vendor/bin/phpcs"',
  '    chmod +x "$dest/vendor/bin/drush" "$dest/vendor/bin/phpunit" "$dest/vendor/bin/phpcs"',
  '    printf "<?php\\n" > "$dest/web/index.php"',
  '    printf "<?php\\n" > "$dest/web/core/lib/Drupal.php"',
  '    printf "\\n" > "$dest/web/modules/.gitkeep"',
  "    ;;",
  "  require|update|config)",
  '    if test -n "$working"; then',
  '      mkdir -p "$working/vendor/bin"',
  "      for bin in drush phpunit phpcs phpstan phpcbf; do",
  '        if ! test -x "$working/vendor/bin/$bin"; then printf "#!/bin/sh\\n" > "$working/vendor/bin/$bin"; chmod +x "$working/vendor/bin/$bin"; fi',
  "      done",
  "    fi",
  "    ;;",
  "  *) exit 2;;",
  "esac",
].join("\n");

const fakePhp = ["#!/bin/sh", "set -eu", "exit 0"].join("\n");

const fixture = async (options: { project?: string; type?: string; extraInfo?: boolean } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "lando-drupal-contrib-scaffold-"));
  roots.push(root);
  const project = options.project ?? "example";
  const type = options.type ?? "module";
  const appRoot = join(root, "app");
  const stagingRoot = join(root, "staging");
  const bin = join(root, "bin");
  const mount = join(appRoot, "web", `${type}s`, "custom", project);
  await Promise.all([mkdir(mount, { recursive: true }), mkdir(stagingRoot, { recursive: true }), mkdir(bin)]);
  await writeFile(
    join(mount, `${project}.info.yml`),
    ["name: Example", `type: ${type}`, "core_version_requirement: ^11"].join("\n"),
  );
  await writeFile(
    join(mount, "composer.json"),
    JSON.stringify({ name: `drupal/${project}`, type: `drupal-${type}` }, null, 2),
  );
  await writeFile(join(mount, "src.txt"), "extension-source\n");
  if (options.extraInfo) await writeFile(join(mount, "other.info.yml"), "name: Other\ntype: module\n");
  await writeFile(join(bin, "composer"), fakeComposer);
  await writeFile(join(bin, "php"), fakePhp);
  await Promise.all([chmod(join(bin, "composer"), 0o755), chmod(join(bin, "php"), 0o755)]);
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    LANDO_DRUPAL_CONTRIB_APP_ROOT: appRoot,
    LANDO_DRUPAL_CONTRIB_STAGING_ROOT: stagingRoot,
    LANDO_TEST_COMPOSER_LOG: join(root, "composer.log"),
  };
  const run = () =>
    Bun.spawnSync(["/bin/sh", "-c", drupalContribScaffoldCommand("^11", project, type)], { env });
  return { appRoot, mount, project, type, log: join(root, "composer.log"), run };
};

describe("Drupal contrib scaffold around an empty volume", () => {
  test("fills /app around a nested bind whose parent dirs already exist", async () => {
    const { appRoot, mount, project, type, log, run } = await fixture();

    const first = run();

    expect(first.exitCode, first.stderr.toString() || first.stdout.toString()).toBe(0);
    expect(await Bun.file(join(appRoot, "composer.json")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, "vendor/bin/drush")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, "web/index.php")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, "web/core/lib/Drupal.php")).exists()).toBe(true);
    expect(await readFile(join(mount, "src.txt"), "utf8")).toBe("extension-source\n");
    expect(await Bun.file(join(mount, `${project}.info.yml`)).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, "web", `${type}s`, "contrib", project)).exists()).toBe(false);
    expect(await Bun.file(join(appRoot, ".lando-drupal-contrib-scaffold-complete")).exists()).toBe(true);
    const composerLog = await readFile(log, "utf8");
    expect(composerLog).toContain("create-project");
    expect(composerLog).not.toContain(`drupal/${project}:`);
    expect(
      composerLog
        .split("\n")
        .some((line) => /(?:^|\s)require(?:\s|$)/.test(line) && line.includes(`drupal/${project}`)),
    ).toBe(false);

    const second = run();
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr.toString()).toContain("already scaffolded");
  });

  test("does not treat bind-created web/ parent dirs as a preexisting Drupal tree", async () => {
    const { appRoot, run } = await fixture();
    expect(await Bun.file(join(appRoot, "web/index.php")).exists()).toBe(false);
    expect(await Bun.file(join(appRoot, "web/core")).exists()).toBe(false);

    const result = run();

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(await Bun.file(join(appRoot, "web/index.php")).exists()).toBe(true);
    expect(await Bun.file(join(appRoot, "web/core/lib/Drupal.php")).exists()).toBe(true);
  });

  test("fails when the root info.yml machine name does not match project", async () => {
    const { run } = await fixture({ project: "example" });
    const mismatched = await fixture({ project: "other_module" });
    await writeFile(join(mismatched.mount, "example.info.yml"), "name: Example\ntype: module\n");
    await rm(join(mismatched.mount, "other_module.info.yml"));
    const result = mismatched.run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("does not match recipe.project");
    expect(run().exitCode).toBe(0);
  });

  test("fails when more than one root info.yml is present", async () => {
    const { run } = await fixture({ extraInfo: true });
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("exactly one *.info.yml");
  });

  test("fails when the root info.yml type does not match recipe.type", async () => {
    const { mount, run } = await fixture({ project: "example", type: "module" });
    await writeFile(join(mount, "example.info.yml"), "name: Example\ntype: theme\n");
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("does not match recipe.type");
  });
});
