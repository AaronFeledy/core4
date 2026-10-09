import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRUPAL_CMS_SCAFFOLD_COMMAND } from "../../src/recipes/builtin/drupal-cms/commands.ts";
import { fakeCmsComposer, fakeCmsGit } from "./drupal-cms-composer-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async (mode = "secure") => {
  const root = await mkdtemp(join(tmpdir(), "lando-cms-security-"));
  roots.push(root);
  const app = join(root, "app");
  const stage = join(root, "stage");
  const bin = join(root, "bin");
  const log = join(root, "composer.log");
  await Promise.all([mkdir(app), mkdir(stage), mkdir(bin)]);
  await Promise.all([
    writeFile(join(bin, "composer"), fakeCmsComposer),
    writeFile(join(bin, "git"), fakeCmsGit),
    writeFile(join(app, "user.txt"), "keep me\n"),
  ]);
  await Promise.all([chmod(join(bin, "composer"), 0o755), chmod(join(bin, "git"), 0o755)]);
  const run = () =>
    Bun.spawnSync(["/bin/sh", "-c", DRUPAL_CMS_SCAFFOLD_COMMAND], {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        LANDO_DRUPAL_CMS_APP_ROOT: app,
        LANDO_DRUPAL_CMS_STAGING_ROOT: stage,
        LANDO_TEST_COMPOSER_MODE: mode,
        LANDO_TEST_COMPOSER_LOG: log,
      },
    });
  return { app, stage, log, run };
};

test("keeps the projected 3.x-dev pin through native hooks when staged negotiation succeeds", async () => {
  // Given an empty app with unrelated user content and an offline Composer boundary.
  const { app, log, run } = await fixture();
  // When the real scaffold shell executes.
  const result = run();
  // Then both deferred root hooks run after verified install, and the projected pin survives recipe unpack.
  expect(result.exitCode).toBe(0);
  expect((await Bun.file(log).text()).trim().split("\n")).toEqual([
    "create-project",
    "config",
    "require",
    "update",
    "audit",
    "install",
    "run-script post-update-cmd",
    "run-script post-create-project-cmd",
    "audit",
  ]);
  const root = await Bun.file(join(app, "composer.json")).json();
  expect(root.require).toMatchObject({
    "drupal/svg_image": "3.x-dev",
    "enshrined/svg-sanitize": "^1.0",
    "drupal/gin": "^5",
  });
  expect(root.require).not.toHaveProperty("drupal/drupal_cms_starter");
  expect(Object.keys(root.repositories)[0]).toBe("lando-svg-image");
  expect(root.repositories["lando-svg-image"]).toMatchObject({
    type: "package",
    package: {
      name: "drupal/svg_image",
      version: "3.x-dev",
      source: { type: "git", reference: "c788b1e2f2be29f62c9812b2b0558472afa61d6d" },
      require: { "enshrined/svg-sanitize": "^1.0" },
    },
  });
  expect(await Bun.file(join(app, "vendor", "bin", "composer")).exists()).toBe(false);
  expect(await Bun.file(join(app, "composer.lock")).json()).toMatchObject({
    aliases: [],
    packages: expect.arrayContaining([
      expect.objectContaining({
        name: "drupal/svg_image",
        version: "3.x-dev",
        source: expect.objectContaining({ reference: "c788b1e2f2be29f62c9812b2b0558472afa61d6d" }),
      }),
    ]),
  });
});

test.each([
  "repo-tamper",
  "lock-ref",
  "lock-url",
  "lock-type",
  "lock-license",
  "lock-version",
  "lock-alias",
  "lock-require",
  "lock-autoload",
  "lock-extra",
  "installed-ref",
  "installed-dirty",
  "installed-source",
  "installed-require",
  "installed-extra",
  "hook-rewrite",
  "resolve-fail",
  "install-fail",
  "audit-fail",
])("publishes nothing and preserves user files when %s occurs", async (mode) => {
  // Given an adversarial dependency boundary in a private stage.
  const { app, stage, log, run } = await fixture(mode);
  // When the real scaffold shell executes.
  const result = run();
  // Then failure leaves no project, journal, or stage behind.
  expect(result.exitCode).not.toBe(0);
  expect(await readdir(app)).toEqual(["user.txt"]);
  expect(await Bun.file(join(app, "user.txt")).text()).toBe("keep me\n");
  expect(await readdir(stage)).toEqual([]);
  if (mode.startsWith("lock-") || mode === "repo-tamper")
    expect(await Bun.file(log).text()).not.toContain("install\n");
});
