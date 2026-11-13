import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { COMMAND_REGISTRY_MANIFEST } from "../../src/cli/generated/command-registry-manifest.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

const nonHiddenBuiltInCount = Object.values(COMMAND_REGISTRY_MANIFEST.commands).filter(
  (entry) => !entry.hidden,
).length;

const runCli = async (argv: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...argv],
    // Outside any app so app commandAliases and tooling can't change help dispatch.
    cwd: tmpdir(),
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
    expect(result.stdout).toContain("meta:events:follow");
  });

  test("Given the full catalog, when --help --all is requested, then deferred ids appear", async () => {
    // Given / When
    const result = await runCli(["--help", "--all"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("meta:events:follow");
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
    expect(result.exitCode).toBe(2);
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
    expect(
      (envelope as { result: { all: ReadonlyArray<{ source: string }> } }).result.all.filter(
        (row) => row.source === "built-in",
      ),
    ).toHaveLength(nonHiddenBuiltInCount);
  });
});

describe("help command flag legality", () => {
  test.each([{ argv: ["help", "info", "--version"] }, { argv: ["help", "-v"] }])(
    "Given $argv, when dispatched, then the help command rejects the Lando control",
    async ({ argv }) => {
      // Given / When
      const result = await runCli(argv);

      // Then
      expect(result.exitCode).toBe(2);
      expect(`${result.stdout}\n${result.stderr}`).toContain("UnknownCliFlagError");
    },
  );

  test("Given help info --help, when dispatched, then command help renders", async () => {
    // Given / When
    const result = await runCli(["help", "info", "--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });

  test("Given -- --format=json, when dispatched, then root text help renders", async () => {
    // Given / When
    // Bun consumes the first `--` before the script path; a compiled binary passes one.
    const result = await runCli(["--", "--", "--format=json"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("COMMON");
  });

  test("Given --json --help, when dispatched, then the machine catalog renders", async () => {
    // Given / When
    const result = await runCli(["--json", "--help"]);
    const envelope = JSON.parse(result.stdout) as {
      result: { sections: { common: ReadonlyArray<unknown> } };
    };

    // Then
    expect(result.exitCode).toBe(0);
    expect(envelope).toMatchObject({ command: "cli:help", ok: true });
    expect(envelope.result.sections.common.length).toBeGreaterThan(0);
  });

  test("Given help info --json --jq ., when dispatched, then help wins over the conflict check", async () => {
    // Given / When
    const result = await runCli(["help", "info", "--json", "--jq", "."]);

    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  test("Given an unknown command with --version outside an app, then Lando's version is not printed", async () => {
    // Given / When
    const result = await runCli(["bogus", "--version"]);

    // Then
    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Unknown command "bogus".');
  });
});
