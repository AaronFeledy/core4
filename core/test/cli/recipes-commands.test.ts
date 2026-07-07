import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: ReadonlyArray<string>, cwd: string = repoRoot): Promise<RunResult> => {
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

const lastJsonLine = (text: string): Record<string, unknown> => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  const last = lines.at(-1);
  if (last === undefined) throw new Error(`No JSON line found in: ${text}`);
  return JSON.parse(last) as Record<string, unknown>;
};

describe("meta:recipes:list", () => {
  test("lists bundled recipes including toolbox", async () => {
    const result = await runCli(["meta", "recipes", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("toolbox");
    expect(result.stdout).toContain("Bundled recipes");
  }, 30_000);

  test("bare `recipes` top-level alias routes to the list", async () => {
    const result = await runCli(["recipes"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("toolbox");
  }, 30_000);

  test("--format json emits an ok envelope with the recipe catalog", async () => {
    const result = await runCli(["meta:recipes:list", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const envelope = lastJsonLine(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("meta:recipes:list");
    const recipes = (envelope.result as { recipes: ReadonlyArray<{ id: string }> }).recipes;
    expect(recipes.map((entry) => entry.id)).toContain("toolbox");
  }, 30_000);
});

describe("meta:recipes:describe", () => {
  test("describes the bundled toolbox recipe with its prompt defaults", async () => {
    const result = await runCli(["meta", "recipes", "describe", "toolbox", "--format", "json"]);
    expect(result.exitCode).toBe(0);
    const envelope = lastJsonLine(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("meta:recipes:describe");
    const described = envelope.result as {
      id: string;
      prompts: ReadonlyArray<{ name: string; default?: string }>;
    };
    expect(described.id).toBe("toolbox");
    expect(described.prompts.length).toBeGreaterThan(0);
    for (const prompt of described.prompts) {
      expect(prompt.default, `prompt "${prompt.name}" must have a default`).toBeDefined();
    }
  }, 30_000);

  test("unknown recipe fails with tagged RecipeManifestNotFoundError", async () => {
    const result = await runCli(["meta", "recipes", "describe", "nope-nothing", "--format", "json"]);
    expect(result.exitCode).toBe(1);
    const envelope = lastJsonLine(result.stdout);
    expect(envelope.ok).toBe(false);
    expect((envelope.error as { _tag: string })._tag).toBe("RecipeManifestNotFoundError");
  }, 30_000);

  test("local recipe.ts is not evaluated by describe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-recipes-describe-"));
    const marker = join(dir, "executed.txt");
    writeFileSync(
      join(dir, "recipe.ts"),
      [
        `await Bun.write(${JSON.stringify(marker)}, "executed");`,
        "export default {",
        `  id: ${JSON.stringify(basename(dir))},`,
        '  title: "Executable",',
        '  description: "Must not execute during describe.",',
        '  version: "0.0.1",',
        "};",
        "",
      ].join("\n"),
    );

    const result = await runCli(["meta", "recipes", "describe", dir, "--format", "json"]);

    expect(result.exitCode).toBe(1);
    const envelope = lastJsonLine(result.stdout);
    expect(envelope.ok).toBe(false);
    expect((envelope.error as { _tag: string })._tag).toBe("RecipeManifestNotFoundError");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});

describe("meta:recipes:validate", () => {
  test("validates the canonical toolbox recipe.yml from a repo-relative path", async () => {
    const result = await runCli([
      "meta",
      "recipes",
      "validate",
      "recipes/toolbox/recipe.yml",
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = lastJsonLine(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("meta:recipes:validate");
    expect((envelope.result as { valid: boolean; id: string }).valid).toBe(true);
    expect((envelope.result as { id: string }).id).toBe("toolbox");
  }, 30_000);

  test("rejects an invalid manifest with a tagged error envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lando-recipes-validate-"));
    writeFileSync(join(dir, "recipe.yml"), "id: broken\ntitle: Broken\n");
    const result = await runCli(["meta", "recipes", "validate", join(dir, "recipe.yml"), "--format", "json"]);
    expect(result.exitCode).toBe(1);
    const envelope = lastJsonLine(result.stdout);
    expect(envelope.ok).toBe(false);
    expect((envelope.error as { _tag: string })._tag).toBe("RecipeManifestValidationError");
  }, 30_000);

  test("missing file fails with RecipeManifestNotFoundError", async () => {
    const result = await runCli([
      "meta",
      "recipes",
      "validate",
      "/tmp/no-such-recipe-dir-xyz",
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(1);
    const envelope = lastJsonLine(result.stdout);
    expect(envelope.ok).toBe(false);
    expect((envelope.error as { _tag: string })._tag).toBe("RecipeManifestNotFoundError");
  }, 30_000);
});
