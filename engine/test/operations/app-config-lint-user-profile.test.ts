import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PathsService, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

test("lints user includes against runtime roots rather than a conflicting process profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-profile-lint-"));
  const previousConf = process.env.LANDO_USER_CONF_ROOT;
  const paths = makeLandoPaths({ userConfRoot: join(root, "runtime"), userCacheRoot: join(root, "cache") });
  try {
    await mkdir(paths.userIncludesDir, { recursive: true });
    await mkdir(join(root, "host", "includes"), { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: profile-lint\nincludes: [user:profile.yml]\n");
    await writeFile(
      join(paths.userIncludesDir, "profile.yml"),
      "tooling:\n  check:\n    cmd: echo profile\n",
    );
    await writeFile(join(root, "host", "includes", "profile.yml"), "name: forbidden\n");
    process.env.LANDO_USER_CONF_ROOT = join(root, "host");
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(
        Effect.provide(PluginRegistryLayer.layer),
        Effect.provideService(PathsService, paths),
        Effect.provideService(
          StateStore,
          makeStateStore({
            privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
          }),
        ),
      ),
    );
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  } finally {
    if (previousConf === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
    else process.env.LANDO_USER_CONF_ROOT = previousConf;
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an array-position expression failure with a numeric path segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-expression-lint-index-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: expression-lint",
        "runtime: 4",
        "services:",
        "  database:",
        "    type: mariadb",
        "tooling:",
        "  seed:",
        "    service: database",
        "    cmds:",
        '      - "echo ok"',
        '      - "echo {{ app.nope }}"',
        "",
      ].join("\n"),
    );
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      { path: ["tooling", "seed", "cmds", 1], message: expect.any(String) },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a deferred expression failure as a lint violation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-expression-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: expression-lint",
        "runtime: 4",
        "services:",
        "  database:",
        "    type: mariadb",
        '    database: "{{ app.nope }}"',
        "",
      ].join("\n"),
    );
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toMatchObject([{ path: ["services", "database", "database"] }]);
    expect(result.violations[0]?.message).toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
