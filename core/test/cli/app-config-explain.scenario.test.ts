import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";

import { CommandResultEnvelope } from "@lando/sdk/schema";

import { AppConfigExplainResultSchema } from "../../src/cli/commands/app-config-explain.ts";
import { lampProducer } from "../../src/recipes/builtin/lamp/snapshot.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-config-explain-scenario-")));
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

/** A lamp Landofile with a chosen `php` and a taken-over `webroot` site. */
const MANAGED_LANDOFILE = [
  "name: explain-demo",
  "recipe:",
  "  id: lamp",
  "  options:",
  '    composer: "2"',
  "    database: mariadb:11.4",
  '    php: "8.2"',
  "    webroot: /app",
  "  producer:",
  `    contentDigest: ${lampProducer.contentDigest}`,
  `    manifestVersion: ${lampProducer.manifestVersion}`,
  `    packageName: "${lampProducer.packageName}"`,
  `    recipeId: ${lampProducer.recipeId}`,
  `    sourceKind: ${lampProducer.sourceKind}`,
  `  version: ${lampProducer.manifestVersion}`,
  "runtime: 4",
  "services:",
  "  appserver:",
  '    type: "php:{{ recipe.php }}"',
  "    webroot: /app",
  "  database:",
  '    type: "{{ recipe.database }}"',
  "",
].join("\n");

const decodeResult = (stdout: string) => {
  const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(stdout));
  expect(envelope.apiVersion).toBe("v4");
  expect(envelope.command).toBe("app:config:explain");
  expect(envelope.ok).toBe(true);
  return Schema.decodeUnknownSync(AppConfigExplainResultSchema)(envelope.result);
};

describe("lando app:config:explain CLI", () => {
  test("reports managed and taken-over sites through the machine envelope", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), MANAGED_LANDOFILE);
      const result = await runCli(["app:config:explain", "--format=json"], dir);

      expect(result.exitCode).toBe(0);
      const report = decodeResult(result.stdout);
      expect(report.comparison).toEqual({
        status: "matched",
        snapshotVersion: lampProducer.manifestVersion,
      });

      const php = report.options.find((option) => option.name === "php");
      expect(php?.status).toBe("chosen-by-value");
      expect(php?.references.map((site) => site.path)).toEqual(["services.appserver.type"]);

      const webroot = report.options.find((option) => option.name === "webroot");
      expect(webroot?.takenOver.map((site) => site.path)).toEqual(["services.appserver.webroot"]);
    });
  });

  test("blocks bare provenance without failing the command", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        'name: explain-demo\nrecipe: lamp\nruntime: 4\nservices:\n  appserver:\n    type: "php:{{ recipe.php }}"\n',
      );
      const result = await runCli(["app:config:explain", "--format=json"], dir);

      expect(result.exitCode).toBe(0);
      const report = decodeResult(result.stdout);
      expect(report.form).toBe("bare");
      expect(report.comparison.status === "blocked" ? report.comparison.reason : "matched").toBe(
        "bare-provenance",
      );
    });
  });

  test("renders a human report through the space-separated phrase", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), MANAGED_LANDOFILE);
      const result = await runCli(["app", "config", "explain"], dir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Recipe: lamp");
      expect(result.stdout).toContain("Comparison: matched against snapshot");
      expect(result.stdout).toContain("status: chosen-by-value");
      expect(result.stdout).toContain("taken over: services.appserver.webroot");
    });
  });
});
