import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const runSourcePath = resolve(repoRoot, "core/src/cli/run.ts");
const currentGuidancePaths = [
  "AGENTS.md",
  "core/AGENTS.md",
  "core/src/testing/scenario-context.ts",
  "README.md",
  "docs/embedding.md",
  "docs/guides/INDEX.md",
  "docs/guides/scripting-with-json.mdx",
  "docs/guides/setup/file-sync-mutagen.mdx",
  "docs/guides/release/linux-acceptance-rehearsal.mdx",
  "docs/guides/library/embedding-defaults.mdx",
] as const;

const readRepoFile = (path: string): Promise<string> => Bun.file(resolve(repoRoot, path)).text();

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runSourceCli = async (args: ReadonlyArray<string>): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repoRoot,
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

describe("native CLI dispatch unification", () => {
  test("current guidance describes the landed single native dispatcher", async () => {
    // Given the bounded set of current operational guidance surfaces.
    const surfaces = await Promise.all(
      currentGuidancePaths.map(async (path) => {
        const text = await readRepoFile(path);
        return { path, text };
      }),
    );

    // When current guidance is inspected independently of historical records.
    const stale = surfaces.flatMap(({ path, text }) =>
      text
        .split("\n")
        .map((line, index) => ({ path, line, lineNumber: index + 1 }))
        .filter(({ line }) =>
          /still dispatches through OCLIF|source-mode OCLIF|not yet unified|Until US-522\.\.US-531|OCLIF removal in flight|mid-migration \(US-522\.\.US-531\)|migration is in flight/i.test(
            line,
          ),
        ),
    );

    // Then the landed architecture is stated and no in-flight marker survives.
    expect(surfaces.map(({ text }) => text).join("\n")).toMatch(
      /source and compiled[^\n]*share (?:one|the same) native command registry(?:\/| and )dispatcher/i,
    );
    expect(stale).toEqual([]);
  });

  test("source and compiled entries delegate to the native dispatcher", async () => {
    // Given the shipping dispatcher module.
    const source = await Bun.file(runSourcePath).text();

    // When its imports and public runner are inspected.
    const runCliSource = source.slice(source.indexOf("export const runCli ="));

    // Then no source-only OCLIF dispatch path remains.
    expect(source).not.toContain('import { execute } from "@oclif/core"');
    expect(runCliSource).not.toMatch(/\bexecute\s*\(/);
    expect(runCliSource).toContain("await runCompiledCli(options.argv)");
  });

  test("source entry uses native argument validation", async () => {
    // Given an argument rejected by the native app:shell adapter.
    const args = ["shell", "web"] as const;

    // When the source entry dispatches it.
    const result = await runSourceCli(args);

    // Then native validation, not OCLIF topic resolution, reports the failure.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unexpected argument: web");
    expect(result.stderr).not.toContain("COMMAND_NOT_FOUND");
  }, 30_000);

  test("source entry returns the version result envelope", async () => {
    // Given the canonical version command in machine-output mode.
    const args = ["meta:version", "--format=json"] as const;

    // When the source entry dispatches it.
    const result = await runSourceCli(args);

    // Then it returns a successful schema-shaped envelope.
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      apiVersion: "v4",
      command: "meta:version",
      ok: true,
      result: { core: expect.any(String) },
    });
    expect(result.stderr).toBe("");
  }, 60_000);
});
