import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileToolingCommands } from "@lando/engine/cache/command-compiler";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { rememberInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { LandofileShape } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { resolveToolingRoute } from "../../src/cli/tooling-router.ts";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");

const withCachedTasks = async (run: (root: string, cacheRoot: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-cached-task-help-"));
  const cacheRoot = join(root, "cache");
  try {
    // Invalid source prevents help from silently falling back to a live planner.
    await writeFile(join(root, ".lando.yml"), "name: [invalid\n");
    const landofile = rememberInternalToolingTasks(
      Schema.decodeUnknownSync(LandofileShape)({
        name: "cached-tasks",
        tooling: {
          "db:wait": { cmd: "echo must-not-run", arguments: false },
          "docs:build": { cmd: "echo must-not-run", arguments: false },
          retired: { cmd: "echo must-not-run", disabled: true },
          removed: false,
        },
      }),
      ["docs:build"],
    );
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        cwd: root,
        cacheRoot,
        landofile,
        entries: compileToolingCommands(landofile),
      }),
    );
    await run(root, cacheRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const invoke = async (root: string, cacheRoot: string, argv: readonly string[]) => {
  const child = Bun.spawn([process.execPath, cli, ...argv], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

test("nested task machine help advertises a token accepted by the unchanged dispatcher", async () => {
  // Given
  await withCachedTasks(async (root, cacheRoot) => {
    // When
    const result = await invoke(root, cacheRoot, ["help", "app:db:wait", "--format=json"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    const envelope: unknown = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ ok: true, result: { target: { typeable: "app:db:wait", extras: [] } } });
    const { result: help } = Schema.decodeUnknownSync(
      Schema.Struct({ result: Schema.Struct({ target: Schema.Struct({ typeable: Schema.String }) }) }),
    )(envelope);
    expect(
      await Effect.runPromise(resolveToolingRoute(help.target.typeable, { cwd: root, cacheRoot })),
    ).toMatchObject({ _tag: "tooling", commandId: "app:db:wait" });
    expect(await Effect.runPromise(resolveToolingRoute("db:wait", { cwd: root, cacheRoot }))).toEqual({
      _tag: "not-tooling",
    });
  });
});

test("nested task text help uses its callable canonical id", async () => {
  // Given
  await withCachedTasks(async (root, cacheRoot) => {
    // When
    const result = await invoke(root, cacheRoot, ["help", "app:db:wait"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("\n  lando app:db:wait\n");
  });
});

test.each([{ argv: ["help", "app:docs:build"] }, { argv: ["app:docs:build", "--help"] }])(
  "enabled internal task has direct help for $argv",
  async ({ argv }) => {
    // Given
    await withCachedTasks(async (root, cacheRoot) => {
      // When
      const result = await invoke(root, cacheRoot, [...argv, "--format=json"]);
      // Then
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        result: { target: { canonicalId: "app:docs:build", typeable: "app:docs:build" } },
      });
    });
  },
);

test("internal and disabled tasks remain absent from cached listings", async () => {
  // Given
  await withCachedTasks(async (root, cacheRoot) => {
    // When
    const result = await invoke(root, cacheRoot, ["--help", "--format=json"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    const envelope = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          sections: Schema.Struct({
            thisApp: Schema.Array(Schema.Struct({ canonicalId: Schema.String, typeable: Schema.String })),
          }),
        }),
      }),
    )(JSON.parse(result.stdout));
    expect(envelope.result.sections.thisApp).toEqual([
      expect.objectContaining({ canonicalId: "app:db:wait", typeable: "app:db:wait" }),
    ]);
  });
});

test.each(["retired", "removed"])("disabled declaration %s retains typed help refusal", async (name) => {
  // Given
  await withCachedTasks(async (root, cacheRoot) => {
    // When
    const result = await invoke(root, cacheRoot, ["help", `app:${name}`, "--format=json"]);
    // Then
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "ToolingDisabledError", tool: name },
    });
  });
});
