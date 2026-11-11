import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const biomeBin = Bun.which("biome", { PATH: resolve(repoRoot, "node_modules/.bin") });

/**
 * Biome 2's `recommended` preset stopped reporting rules that Biome 1 raised as
 * errors, so `biome.jsonc` re-pins each one at `error`. These cases are the pins
 * whose demotion would silently widen the lint surface: each fixture violates one
 * rule, and the assertions below prove the pin is what reports it. A rule that
 * becomes recommended again keeps passing the repo assertion, and its preset
 * assertion starts failing, which is the signal to drop the pin from the config.
 */
const PINNED_CASES = [
  {
    rule: "complexity/noForEach",
    file: "fixture.ts",
    source: "export const visit = (values: number[]) => values.forEach((value) => value);\n",
  },
  {
    rule: "performance/noDelete",
    file: "fixture.ts",
    source: "const record = { value: 1 };\ndelete record.value;\n",
  },
  {
    rule: "style/noParameterAssign",
    file: "fixture.ts",
    source: "export function replace(value: number) {\n  value = 1;\n  return value;\n}\n",
  },
  {
    rule: "style/useEnumInitializers",
    file: "fixture.ts",
    source: "export enum Mode {\n  Read,\n}\n",
  },
  {
    rule: "suspicious/noFocusedTests",
    file: "fixture.test.ts",
    source: 'import { describe } from "bun:test";\n\ndescribe.only("focused", () => {});\n',
  },
  {
    rule: "suspicious/noVar",
    file: "fixture.ts",
    source: "export var counter = 1;\n",
  },
] as const;

const workDir = await mkdtemp(join(repoRoot, ".biome-pins-"));
const presetDir = join(workDir, "preset-only");
await mkdirPreset(presetDir);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function mkdirPreset(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "biome.json"),
    JSON.stringify({ linter: { enabled: true, rules: { preset: "recommended" } } }),
  );
}

const lint = async (configPath: string, file: string): Promise<{ exitCode: number; output: string }> => {
  if (biomeBin === null) throw new Error("node_modules/.bin has no biome; run bun install.");
  const child = Bun.spawn([biomeBin, "lint", `--config-path=${configPath}`, "--reporter=summary", file], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
};

test("biome.jsonc keeps comments out of a file Biome parses as JSON", async () => {
  // Given: Biome parses `biome.json` as strict JSON and rejects comments, so the
  // rationale comments in this repository require the `.jsonc` name.
  const configPath = join(repoRoot, "biome.jsonc");

  // Then
  expect(await Bun.file(configPath).exists()).toBe(true);
  expect(await Bun.file(join(repoRoot, "biome.json")).exists()).toBe(false);
});

test("biome.jsonc pins every rule the recommended preset no longer reports", async () => {
  // Given
  const config = JSON.parse(
    (await readFile(join(repoRoot, "biome.jsonc"), "utf8")).replace(/^\s*\/\/.*$/gm, ""),
  );
  const rules: Record<string, Record<string, unknown> | string | undefined> = config.linter.rules;
  const severityOf = (ruleId: string): unknown => {
    const [group, rule] = ruleId.split("/") as [string, string];
    const pinnedGroup = rules[group];
    return typeof pinnedGroup === "object" && pinnedGroup !== null ? pinnedGroup[rule] : undefined;
  };

  // Then
  expect(rules.preset).toBe("recommended");
  for (const pinned of PINNED_CASES) expect(severityOf(pinned.rule)).toBe("error");
});

for (const pinned of PINNED_CASES) {
  test(`${pinned.rule} reports under the repository config and not under the preset alone`, async () => {
    // Given
    const fixture = join(workDir, pinned.file);
    await writeFile(fixture, pinned.source);

    // When
    const repository = await lint(repoRoot, fixture);
    const presetOnly = await lint(presetDir, fixture);

    // Then: the repository pin is the only reason this rule still reports.
    expect(repository.output).toContain(`lint/${pinned.rule}`);
    expect(repository.exitCode).not.toBe(0);
    expect(presetOnly.output).not.toContain(`lint/${pinned.rule}`);
  });
}
