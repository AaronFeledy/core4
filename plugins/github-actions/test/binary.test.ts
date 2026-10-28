import { expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { WorkflowInspection } from "../src/schema.ts";
import { repository, validWorkflow } from "./fixtures.ts";

const binary = process.env.LANDO_ACTIONS_TEST_BINARY;
const envelope = Schema.Struct({ ok: Schema.Boolean, result: WorkflowInspection });

it.skipIf(binary === undefined)(
  "links and inspects through an explicit real Lando binary with isolated roots",
  async () => {
    if (binary === undefined) return;
    await using repo = await repository({ "ci.yml": validWorkflow, "bad.yml": "on: [" });
    const env = {
      ...process.env,
      LANDO_USER_CONF_ROOT: join(repo.root, "conf"),
      LANDO_USER_DATA_ROOT: join(repo.root, "data"),
      LANDO_USER_CACHE_ROOT: join(repo.root, "cache"),
      LANDO_SYSTEM_PLUGIN_ROOT: join(repo.root, "system"),
    };
    const build = Bun.spawn([process.execPath, "run", "build:artifact"], {
      cwd: resolve(import.meta.dir, ".."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildOutput, buildError, buildExit] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    expect(buildExit, `${buildOutput}\n${buildError}`).toBe(0);
    const run = async (args: readonly string[]) => {
      const child = Bun.spawn([resolve(binary), ...args], {
        cwd: repo.root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    };
    const link = await run(["meta:plugin:link", resolve(import.meta.dir, "../dist"), "--format=json"]);
    expect(link.exitCode).toBe(0);
    const help = await run(["github-actions:list", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--workflow");
    const inspected = await run(["github-actions:list", "--format=json"]);
    expect(inspected.exitCode).toBe(0);
    const result = Schema.decodeUnknownSync(envelope)(JSON.parse(inspected.stdout));
    expect(result.ok).toBe(true);
    expect(result.result.summary).toEqual({ discovered: 2, inspected: 1, failed: 1, uninspected: 0 });
    expect(inspected.stdout).not.toContain("PRIVATE_SCRIPT");
    const failure = await run(["github-actions:list", "--workflow=../bad.yml", "--format=json"]);
    expect(failure.exitCode).not.toBe(0);
    expect(JSON.parse(failure.stdout)).toMatchObject({
      ok: false,
      error: {
        _tag: "GithubActionsWorkflowError",
        message: "GitHub Actions inspection could not start.",
        reason: "invalid-workflow",
      },
    });
  },
  30_000,
);
