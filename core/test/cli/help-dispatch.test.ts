import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { COMMAND_REGISTRY_MANIFEST } from "../../src/cli/generated/command-registry-manifest.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

const nonHiddenBuiltInCount = Object.values(COMMAND_REGISTRY_MANIFEST.commands).filter(
  (entry) => !entry.hidden,
).length;

const runCli = async (argv: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...argv],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("help dispatcher special", () => {
  test("Given no command, when help is requested, then root help renders without UnknownCommandError", async () => {
    // Given / When
    const result = await runCli(["help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("COMMON");
    expect(result.stderr).not.toContain("UnknownCommandError");
  });

  test("Given the app topic, when help app is requested, then topic help lists config", async () => {
    // Given / When
    const result = await runCli(["help", "app"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("config");
  });

  test("Given the plugin topic, when plugin --help is requested, then topic help lists plugin:add", async () => {
    // Given / When
    const result = await runCli(["plugin", "--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("plugin:add");
  });

  test("Given the full catalog, when help --all is requested, then deferred ids appear", async () => {
    // Given / When
    const result = await runCli(["help", "--all"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("meta:plugin:login");
  });

  test("Given the full catalog, when --help --all is requested, then deferred ids appear", async () => {
    // Given / When
    const result = await runCli(["--help", "--all"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("meta:plugin:login");
  });

  test("Given a registered alias, when help start is requested, then command help renders", async () => {
    // Given / When
    const result = await runCli(["help", "start"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("app:start");
  });

  test("Given an unknown token, when help targets it, then UnknownCommandError renders", async () => {
    // Given / When
    const result = await runCli(["help", "does-not-exist"]);

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("UnknownCommandError");
  });

  test("Given help --all, when JSON format is requested, then the full catalog envelope is emitted", async () => {
    // Given / When
    const result = await runCli(["help", "--all", "--format=json"]);
    const envelope: unknown = JSON.parse(result.stdout);

    // Then
    expect(result.exitCode).toBe(0);
    expect(envelope).toMatchObject({
      apiVersion: "v4",
      command: "cli:help",
      ok: true,
    });
    expect((envelope as { result: { all: ReadonlyArray<unknown> } }).result.all).toHaveLength(
      nonHiddenBuiltInCount,
    );
  });
});
