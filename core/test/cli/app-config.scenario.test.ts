import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";

import { appConfig, renderAppConfigResult } from "@lando/core/cli/operations";
import { LandofileService } from "@lando/core/services";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-app-config-scenario-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
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

describe("lando app:config", () => {
  test("returns the discovered Landofile name, recipe, and service list", async () => {
    const layer = Layer.succeed(LandofileService, {
      discover: Effect.succeed({
        name: "test-app-config",
        recipe: "node",
        services: {},
      }),
    });

    const result = await Effect.runPromise(appConfig().pipe(Effect.provide(layer)));

    expect(result.app).toBe("test-app-config");
    expect(result.source).toBe("resolved");
    expect(result.landofile.name).toBe("test-app-config");
    expect(result.landofile.recipe).toBe("node");
    const table = renderAppConfigResult(result, "table");
    expect(table).toContain("app\ttest-app-config");
    expect(table).toContain("services\t(none)");
    expect(table).toContain("recipe\tnode");
    const json = renderAppConfigResult(result, "json");
    expect(JSON.parse(json)).toMatchObject({ name: "test-app-config", recipe: "node" });
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:config"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });

  test("source CLI --format json emits parseable JSON", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        "name: test-app-config-json\nrecipe: node\nservices:\n  web:\n    type: node\n",
      );
      const result = await runCli(["app:config", "--format", "json"], dir);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { readonly name?: string; readonly recipe?: string };
      expect(parsed.name).toBe("test-app-config-json");
      expect(parsed.recipe).toBe("node");
    });
  });
});
