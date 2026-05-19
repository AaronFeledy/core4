import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-init-prompts-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

interface RunOptions {
  readonly stdin?: string;
}

const runCli = async (
  args: ReadonlyArray<string>,
  cwd: string,
  options: RunOptions = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : "pipe",
  });
  if (options.stdin !== undefined && proc.stdin !== undefined) {
    const writer = proc.stdin;
    writer.write(options.stdin);
    writer.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const flatten = (text: string): string => text.replace(/\s+/g, " ").trim();

describe("lando init — answers and prompting", () => {
  test("--answer name=<value> scaffolds without prompting (non-interactive)", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--full", "--no-interactive", "--answer=name=via-answer"], dir);
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(join(dir, "via-answer", ".lando.yml")).exists()).toBe(true);
      expect(result.stdout).toContain("Created via-answer at");
    });
  });

  test("--no-interactive without --answer raises RecipeMissingAnswerError", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--full", "--no-interactive"], dir);
      expect(result.exitCode).toBe(1);
      const stderr = flatten(result.stderr);
      expect(stderr).toContain('Missing required answer for prompt "name"');
      expect(stderr).toContain("--answer name=<value>");
    });
  });

  test("--no-interactive with an invalid --answer raises RecipePromptValidationError", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--full", "--no-interactive", "--answer=name=Bad Name"], dir);
      expect(result.exitCode).toBe(1);
      const stderr = flatten(result.stderr);
      expect(stderr).toContain('Invalid value for prompt "name"');
      expect(stderr).toContain("App name must be lowercase kebab-case.");
    });
  });

  test("interactive: re-prompts on validation failure, then succeeds", async () => {
    await withTempCwd(async (dir) => {
      // Empty first line accepts the recipe-selection default (node-postgres),
      // then the recipe's name prompt re-prompts after a bad input.
      const scriptedStdin = "\nBad Name\ngood-name\n";
      const result = await runCli(["init"], dir, { stdin: scriptedStdin });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created good-name at");
      expect(await Bun.file(join(dir, "good-name", ".lando.yml")).exists()).toBe(true);
      const transcript = flatten(`${result.stdout}\n${result.stderr}`);
      expect(transcript).toContain("App name must be lowercase kebab-case.");
    });
  });
});
