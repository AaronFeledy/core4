import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import type { LandofileShape } from "@lando/sdk/schema";
import { resolveToolingRoute } from "../../src/cli/tooling-router.ts";

interface CacheFixtureOptions {
  readonly sourceName: string;
  readonly source: string;
  readonly landofile: LandofileShape;
}

interface CacheFixture {
  readonly root: string;
  readonly cacheRoot: string;
}

const entries = [{ id: "app:greet", summary: "Greet", hidden: false, source: "bun-script" }] as const;

const withEnvironment = async <T>(
  overrides: Readonly<Record<string, string>>,
  run: () => Promise<T>,
): Promise<T> => {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
};

const withCacheFixture = async <T>(
  options: CacheFixtureOptions,
  run: (fixture: CacheFixture) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-dynamic-command-aliases-"));
  const cacheRoot = join(root, "cache");
  try {
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(join(root, options.sourceName), options.source);
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        landofile: options.landofile,
        entries,
        cwd: root,
        cacheRoot,
      }),
    );
    return await run({ root, cacheRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("Given an unchanged programmatic Landofile, when routing its alias, then the cache-only hot path resolves it", async () => {
  await withEnvironment(
    {
      LANDO_TEST_ALIAS_NAME: "hi",
      LANDO_TEST_CACHE_SECRET: "raw-secret-must-not-be-persisted",
    },
    async () => {
      await withCacheFixture(
        {
          sourceName: ".lando.ts",
          source: [
            "export default (ctx: { env: Record<string, string | undefined> }) => ({",
            '  name: "dynamic-alias",',
            '  commandAliases: { custom: { [ctx.env.LANDO_TEST_ALIAS_NAME ?? "fallback"]: "app:greet" } },',
            "});",
            "",
          ].join("\n"),
          landofile: {
            name: "dynamic-alias",
            commandAliases: { custom: { hi: "app:greet" } },
          },
        },
        async ({ root, cacheRoot }) => {
          // When
          const route = await Effect.runPromise(resolveToolingRoute("hi", { cwd: root, cacheRoot }));
          const cacheBytes = await readFile(appToolingCompilationCachePath(cacheRoot, root));

          // Then
          expect(route).toMatchObject({
            _tag: "bun-script",
            commandId: "app:greet",
            name: "greet",
          });
          expect(Buffer.from(cacheBytes).includes("raw-secret-must-not-be-persisted")).toBe(false);
        },
      );
    },
  );
});

test("Given a programmatic Landofile cache, when its environment changes, then the hot path rejects it", async () => {
  await withEnvironment({ LANDO_TEST_ALIAS_NAME: "hi" }, async () => {
    await withCacheFixture(
      {
        sourceName: ".lando.ts",
        source: [
          "export default (ctx: { env: Record<string, string | undefined> }) => ({",
          '  name: "dynamic-alias",',
          '  commandAliases: { custom: { [ctx.env.LANDO_TEST_ALIAS_NAME ?? "fallback"]: "app:greet" } },',
          "});",
          "",
        ].join("\n"),
        landofile: {
          name: "dynamic-alias",
          commandAliases: { custom: { hi: "app:greet" } },
        },
      },
      async ({ root, cacheRoot }) => {
        // When
        process.env.LANDO_TEST_ALIAS_NAME = "hello";
        const route = await Effect.runPromise(resolveToolingRoute("hi", { cwd: root, cacheRoot }));

        // Then
        expect(route).toMatchObject({ _tag: "cache-miss", commandId: "app:hi" });
      },
    );
  });
});

test("Given a programmatic Landofile cache, when invocation-control variables change, then its alias remains fresh", async () => {
  await withEnvironment(
    { LANDO_TEST_ALIAS_NAME: "hi", _: "refresh-invocation", BUN_BE_BUN: "", SHLVL: "1" },
    async () => {
      await withCacheFixture(
        {
          sourceName: ".lando.ts",
          source: [
            "export default (ctx: { env: Record<string, string | undefined> }) => ({",
            '  name: "dynamic-alias",',
            '  commandAliases: { custom: { [ctx.env.LANDO_TEST_ALIAS_NAME ?? "fallback"]: "app:greet" } },',
            "});",
            "",
          ].join("\n"),
          landofile: {
            name: "dynamic-alias",
            commandAliases: { custom: { hi: "app:greet" } },
          },
        },
        async ({ root, cacheRoot }) => {
          // When
          process.env._ = "command-substitution-invocation";
          process.env.BUN_BE_BUN = "1";
          process.env.SHLVL = "0";
          const route = await Effect.runPromise(resolveToolingRoute("hi", { cwd: root, cacheRoot }));

          // Then
          expect(route).toMatchObject({ _tag: "bun-script", commandId: "app:greet" });
        },
      );
    },
  );
});

test("Given an unchanged templated Landofile, when routing its alias, then changed render inputs alone invalidate it", async () => {
  await withEnvironment({ LANDO_TEST_ALIAS_TARGET: "app:greet" }, async () => {
    await withCacheFixture(
      {
        sourceName: ".lando.yml",
        source: [
          "template: handlebars",
          "name: templated-alias",
          "commandAliases:",
          "  custom:",
          "    hi: {{env.LANDO_TEST_ALIAS_TARGET}}",
          "",
        ].join("\n"),
        landofile: {
          name: "templated-alias",
          commandAliases: { custom: { hi: "app:greet" } },
        },
      },
      async ({ root, cacheRoot }) => {
        // When
        const freshRoute = await Effect.runPromise(resolveToolingRoute("hi", { cwd: root, cacheRoot }));
        process.env.LANDO_TEST_ALIAS_TARGET = "app:other";
        const staleRoute = await Effect.runPromise(resolveToolingRoute("hi", { cwd: root, cacheRoot }));

        // Then
        expect(freshRoute).toMatchObject({ _tag: "bun-script", commandId: "app:greet" });
        expect(staleRoute).toMatchObject({ _tag: "cache-miss", commandId: "app:hi" });
      },
    );
  });
});

test("Given a static YAML Landofile cache, when the environment changes, then its alias remains fresh", async () => {
  await withEnvironment({ LANDO_TEST_UNRELATED_VALUE: "before" }, async () => {
    await withCacheFixture(
      {
        sourceName: ".lando.yml",
        source: ["name: static-alias", "commandAliases:", "  custom:", "    hi: app:greet", ""].join("\n"),
        landofile: {
          name: "static-alias",
          commandAliases: { custom: { hi: "app:greet" } },
        },
      },
      async ({ root, cacheRoot }) => {
        // When
        process.env.LANDO_TEST_UNRELATED_VALUE = "after";
        const route = await Effect.runPromise(resolveToolingRoute("hi", { cwd: root, cacheRoot }));

        // Then
        expect(route).toMatchObject({ _tag: "bun-script", commandId: "app:greet" });
      },
    );
  });
});
