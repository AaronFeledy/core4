import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";
import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { resolveTopLevelAliases } from "../../src/cli/spec/command-spec.ts";
import {
  appCommandCachePath,
  appToolingCompilationCachePath,
  decodeAppCommandIndex,
  encodeAppCommandIndex,
  writeAppCommandCacheStrict,
} from "../../src/testing/engine-layers.ts";
import { ensureCompiledCli } from "../_support/compiled-cli.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repoRoot, "core");
let binaryPath = "";

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (
  cmd: Array<string>,
  cwd = coreRoot,
  env: Record<string, string | undefined> = process.env,
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd,
    cwd,
    env,
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

describe("app command aliases", () => {
  test("register alias metadata in the native command registry", () => {
    const aliasesById = new Map(
      builtInCommandEntries.map((entry) => [entry.spec.id, resolveTopLevelAliases(entry.spec)] as const),
    );

    expect(aliasesById.get("app:start")).toContain("start");
    expect(aliasesById.get("app:stop")).toContain("stop");
    expect(aliasesById.get("app:info")).toContain("info");
    expect(aliasesById.get("app:exec")).toContain("exec");
    expect(aliasesById.get("app:ssh")).toContain("ssh");
    expect(aliasesById.get("app:shell")).toContain("shell");
    expect(aliasesById.get("apps:scratch:start")).toEqual(
      expect.arrayContaining(["scratch:start", "scratch"]),
    );
    expect(aliasesById.get("apps:scratch:stop")).toContain("scratch:stop");
    expect(aliasesById.get("apps:scratch:destroy")).toContain("scratch:destroy");
    expect(aliasesById.get("apps:scratch:list")).toContain("scratch:list");
    expect(aliasesById.get("apps:scratch:info")).toContain("scratch:info");
    expect(aliasesById.get("apps:scratch:logs")).toContain("scratch:logs");
    expect(aliasesById.get("apps:scratch:gc")).toContain("scratch:gc");
    expect(aliasesById.get("apps:scratch:run")).toEqual(expect.arrayContaining(["scratch:run", "run"]));
    expect(aliasesById.get("meta:recipes:list")).toEqual(expect.arrayContaining(["recipes:list", "recipes"]));
    expect(aliasesById.get("meta:recipes:describe")).toContain("recipes:describe");
    expect(aliasesById.get("meta:recipes:validate")).toContain("recipes:validate");
    expect(aliasesById.get("app:share:list")).toContain("share:list");
    expect(aliasesById.get("app:share:stop")).toContain("share:stop");
  });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "compiled app command aliases",
  () => {
    beforeAll(async () => {
      binaryPath = await ensureCompiledCli();
    }, 120_000);

    test("route top-level aliases to the same compiled handlers as their app ids", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "lando-aliases-"));
      try {
        for (const [alias, appId] of [
          ["start", "app:start"],
          ["stop", "app:stop"],
          ["info", "app:info"],
        ] as const) {
          const aliasResult = await runCommand([binaryPath, alias], cwd);
          const appIdResult = await runCommand([binaryPath, appId], cwd);

          expect(aliasResult.exitCode, alias).toBe(appIdResult.exitCode);
          expect(aliasResult.stdout, alias).toBe(appIdResult.stdout);
          expect(aliasResult.stderr, alias).toBe(appIdResult.stderr);
          expect(aliasResult.exitCode, alias).not.toBe(0);
          expect(aliasResult.stderr, alias).toContain(
            "Run `lando init --full --name=<name>` to scaffold an app.",
          );
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, 120_000);

    test("route app command overrides through the compiled dispatcher", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "lando-compiled-app-alias-"));
      const cacheRoot = join(cwd, "cache");
      try {
        await mkdir(join(cwd, ".lando", "scripts"), { recursive: true });
        await writeFile(join(cwd, ".lando.yml"), "name: compiled-alias\n");
        await writeFile(join(cwd, ".lando", "scripts", "greet.bun.sh"), "echo -n compiled-alias-ok\n");
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile: {
              name: "compiled-alias",
              commandAliases: {
                custom: { start: "app:greet", bun: "app:greet", x: "app:greet" },
              },
            },
            entries: [{ id: "app:greet", summary: "Greet", hidden: false, source: "bun-script" }],
            cwd,
            cacheRoot,
          }),
        );
        const compiledVersion = (await runCommand([binaryPath, "--version"])).stdout.trim();
        for (const path of [
          appCommandCachePath(cacheRoot, "compiled-alias", cwd),
          appToolingCompilationCachePath(cacheRoot, cwd),
        ]) {
          const payload = decodeAppCommandIndex(new Uint8Array(await readFile(path)));
          if (payload === null) throw new Error(`Could not decode app command cache at ${path}`);
          await writeFile(path, encodeAppCommandIndex({ ...payload, landoVersion: compiledVersion }));
        }
        const env = { ...process.env, LANDO_USER_CACHE_ROOT: cacheRoot };

        const results = await Promise.all(
          ["start", "bun", "x"].map((alias) => runCommand([binaryPath, alias, "--format=json"], cwd, env)),
        );

        for (const result of results) expect(result.stdout).toContain('"command":"app:greet"');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
