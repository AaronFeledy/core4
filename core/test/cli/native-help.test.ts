import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = async (argv: ReadonlyArray<string>): Promise<RunResult> => {
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

const STACK_OR_SOURCE_PATH = /(^\s*at\s+\S+)|\/[A-Za-z0-9_.\-/]+\.(?:ts|js)(?:[:?]|\b)/m;

describe("native registry help", () => {
  test("Given the root registry, when help is requested, then registry summaries render without an OCLIF banner", async () => {
    // Given / When
    const result = await runCli(["--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("List Lando apps applied across discovered providers on this host.");
    expect(result.stdout).not.toContain("OCLIF adapter");
  });

  test("Given a registered command, when its help is requested, then registry metadata and class-owned flags render", async () => {
    // Given / When
    const result = await runCli(["meta:plugin:login", "--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Authenticate with a plugin source.");
    expect(result.stdout).not.toContain("Authenticate with a private plugin registry.");
    expect(result.stdout).toContain("meta:plugin:login, plugin:login");
    expect(result.stdout).toContain("--registry");
  });

  test("Given a deferred command, when help is requested, then its phase status renders successfully", async () => {
    // Given / When
    const result = await runCli(["plugin:login", "--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("STATUS");
    expect(result.stdout).toContain("Planned for Lando 4.1.");
  });

  test("Given a bounded compatibility form, when help is requested, then it resolves to canonical command help", async () => {
    // Given / When
    const result = await runCli(["meta", "recipes", "list", "--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("meta:recipes:list");
  });
});

describe("native unknown-command failures", () => {
  test.each([
    ["plain unknown command", ["does-not-exist"]],
    ["unknown help target", ["does-not-exist", "--help"]],
    ["unsupported space form", ["apps", "list"]],
  ] as const)(
    "Given a %s, when dispatched, then a stack-free tagged failure is rendered",
    async (_name, argv) => {
      // Given / When
      const result = await runCli(argv);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("UnknownCommandError");
      expect(result.stderr).toContain(`Command ${argv[0]} not found`);
      expect(result.stderr).toContain("↳");
      expect(result.stderr).not.toMatch(STACK_OR_SOURCE_PATH);
    },
  );

  test("Given JSON output, when an unknown command is dispatched, then a valid machine failure envelope renders", async () => {
    // Given / When
    const result = await runCli(["does-not-exist", "--format=json"]);
    const envelope: unknown = JSON.parse(result.stdout);

    // Then
    expect(result.exitCode).toBe(1);
    expect(envelope).toMatchObject({
      command: "cli:unknown-command",
      ok: false,
      error: { _tag: "UnknownCommandError" },
    });
    expect(result.stderr).toBe("");
  });
});
