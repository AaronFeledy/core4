import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Exit, Layer, Schema } from "effect";

import {
  type AppConfigResult,
  AppConfigResultSchema,
  appConfig,
  renderAppConfigResult,
} from "@lando/core/cli/operations";
import { LandofileService } from "@lando/core/services";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const parseEnvelopeResult = <A>(stdout: string): A => {
  const envelope = JSON.parse(stdout) as { readonly ok?: boolean; readonly result?: unknown };
  expect(envelope.ok).toBe(true);
  return envelope.result as A;
};

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
    expect(result.landofile?.name).toBe("test-app-config");
    expect(result.landofile?.recipe).toBe("node");
    const table = renderAppConfigResult(result, "table");
    expect(table).toContain("app\ttest-app-config");
    expect(table).toContain("services\t(none)");
    expect(table).toContain("recipe\tnode");
    expect(Schema.encodeSync(AppConfigResultSchema)(result)).toMatchObject({
      app: "test-app-config",
      source: "resolved",
      landofile: { name: "test-app-config", recipe: "node" },
    });
  });

  test("returns a single resolved value for get", async () => {
    const layer = Layer.succeed(LandofileService, {
      discover: Effect.succeed({
        name: "test-app-config-get",
        recipe: "node",
        services: { web: { type: "node" } },
      }),
    });

    const result = await Effect.runPromise(
      appConfig({ subcommand: "get", key: "services.web.type" }).pipe(Effect.provide(layer)),
    );

    expect(result).toMatchObject({
      app: "test-app-config-get",
      source: "resolved",
      subcommand: "get",
      key: "services.web.type",
      value: "node",
    });
    expect(Schema.encodeSync(AppConfigResultSchema)(result)).toMatchObject({
      subcommand: "get",
      key: "services.web.type",
      value: "node",
    });
  });

  test("renders a get scalar as the selected value only", () => {
    const result: AppConfigResult = {
      subcommand: "get",
      key: "services.web.type",
      value: "node",
    };

    expect(renderAppConfigResult(result, "table")).toBe("node");
  });

  test("renders a missing get value as an empty string", () => {
    const result: AppConfigResult = {
      subcommand: "get",
      key: "services.web.missing",
    };

    expect(renderAppConfigResult(result, "table")).toBe("");
  });

  test("rejects an unrecognized subcommand instead of silently defaulting to view", async () => {
    const layer = Layer.succeed(LandofileService, {
      discover: Effect.succeed({ name: "test-app-config", recipe: "node", services: {} }),
    });

    const exit = await Effect.runPromiseExit(
      appConfig({ subcommand: "bogus" as never }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("CLI rejects a mistyped subcommand instead of succeeding as a view", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        "name: test-app-config-typo\nrecipe: node\nservices:\n  web:\n    type: node\n",
      );
      const result = await runCli(["app:config", "bogus", "--format", "json"], dir);

      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(result.stdout) as {
        readonly ok?: boolean;
        readonly error?: { readonly message?: string };
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.message).toContain("bogus");
    });
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
      const parsed = parseEnvelopeResult<{
        readonly landofile?: { readonly name?: string; readonly recipe?: string };
      }>(result.stdout);
      expect(parsed.landofile?.name).toBe("test-app-config-json");
      expect(parsed.landofile?.recipe).toBe("node");
    });
  });
});
