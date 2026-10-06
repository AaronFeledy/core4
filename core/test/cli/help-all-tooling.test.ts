import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { HelpCatalogResult } from "../../src/cli/compiled-help.ts";
import type { HelpAliasPolicy } from "../../src/cli/help-names.ts";

const cliEntry = resolve(import.meta.dirname, "../../bin/lando.ts");
const decodeCatalog = Schema.decodeUnknownSync(Schema.Struct({ result: HelpCatalogResult }));
const policies = [
  { name: "default aliases", policy: {}, primary: "app:known", extras: [] },
  { name: "custom aliases", policy: { custom: { hi: "app:known" } }, primary: "hi", extras: ["app:known"] },
  {
    name: "disabled custom alias",
    policy: { disabled: ["hi"], custom: { hi: "app:known" } },
    primary: "app:known",
    extras: [],
  },
  {
    name: "aliases disabled",
    policy: { enabled: false, custom: { hi: "app:known" } },
    primary: "app:known",
    extras: [],
  },
] as const satisfies readonly {
  readonly name: string;
  readonly policy: HelpAliasPolicy;
  readonly primary: string;
  readonly extras: readonly string[];
}[];

const runCli = async (argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => {
  const child = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...argv],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return stdout;
};

test.each([...policies])(
  "help --all matches cached tooling catalogs with $name",
  async ({ policy, primary, extras }) => {
    // Given an isolated app and fresh index, including hidden and built-in entries.
    const root = await mkdtemp(join(tmpdir(), "lando-all-help-"));
    const cacheRoot = join(root, "cache");
    const env = {
      ...process.env,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
    };
    const landofile = join(root, ".lando.yml");
    try {
      await writeFile(landofile, "name: all-help\n");
      const cachePath = await Effect.runPromise(
        writeAppCommandCacheStrict({
          landofile: { name: "all-help", commandAliases: policy },
          entries: [
            { id: "app:known", summary: "Known task", hidden: false, source: "bun-script" },
            { id: "app:other", summary: "Other task", hidden: false },
            { id: "app:secret", summary: "Hidden task", hidden: true },
            { id: "app:start", summary: "Built-in duplicate", hidden: false },
          ],
          cwd: root,
          cacheRoot,
        }),
      );

      // When the full text, root text, and machine catalogs are requested.
      const [all, rootHelp, json, flagHelp] = await Promise.all([
        runCli(["help", "--all"], root, env),
        runCli(["--help"], root, env),
        runCli(["help", "--format", "json"], root, env),
        runCli(["--help", "--all"], root, env),
      ]);

      // Then THIS APP uses the same normalized rows and policy on every surface.
      const thisApp = all.split("\nTHIS APP\n")[1];
      expect(thisApp).toBeDefined();
      expect(thisApp?.trim()).toBe(rootHelp.split("\nTHIS APP\n")[1]?.split("\n\nMORE\n")[0]?.trim());
      expect(flagHelp).toBe(all);
      const catalog = decodeCatalog(JSON.parse(json)).result;
      const tooling = catalog.all.filter((row) => row.source === "tooling");
      expect(tooling).toEqual([...catalog.sections.thisApp]);
      expect(tooling.map((row) => row.canonicalId).sort()).toEqual(["app:known", "app:other"]);
      expect(tooling.find((row) => row.canonicalId === "app:known")).toMatchObject({
        typeable: primary,
        extras,
      });
      expect(
        thisApp
          ?.trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0])
          .sort(),
      ).toEqual(tooling.map((row) => row.typeable).sort());
      expect(all).not.toContain("app:secret");
      expect(all).not.toContain("Built-in duplicate");

      // The same populated cache must not leak outside the app.
      const outside = await runCli(["help", "--all"], tmpdir(), env);
      expect(outside).not.toContain("THIS APP");
      expect(outside).not.toContain("app:known");

      // A stale index, then a missing index, preserve the built-in-only catalog.
      await writeFile(landofile, "name: changed-all-help\n");
      expect(await runCli(["help", "--all"], root, env)).toBe(outside);
      expect(cachePath).toBeDefined();
      if (cachePath === undefined) throw new Error("Fixture command index was not written");
      await rm(cachePath);
      expect(await runCli(["help", "--all"], root, env)).toBe(outside);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
