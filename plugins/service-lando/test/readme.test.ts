import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { SUPPORTED_GO_FRAMEWORKS } from "../src/services/go.ts";
import { SUPPORTED_PYTHON_FRAMEWORKS } from "../src/services/python.ts";
import { SUPPORTED_RUBY_FRAMEWORKS } from "../src/services/ruby.ts";

const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));

const readReadme = (): Promise<string> => readFile(README_PATH, "utf-8");

const findFrameworkTable = (readme: string): string => {
  const lines = readme.split("\n");
  const headerIndex = lines.findIndex((line) => /^##+\s+Framework presets/i.test(line));
  if (headerIndex === -1) {
    throw new Error("README is missing a '## Framework presets' section");
  }
  const next = lines
    .slice(headerIndex + 1)
    .findIndex((line) => /^##+\s+/.test(line) && !/^##+\s+Framework presets/i.test(line));
  const end = next === -1 ? lines.length : headerIndex + 1 + next;
  return lines.slice(headerIndex, end).join("\n");
};

const findLanguageRow = (table: string, language: string): string => {
  const lines = table.split("\n");
  const row = lines.find((line) => line.trim().startsWith(`| \`${language}`));
  if (!row) throw new Error(`Framework presets table missing row for language: ${language}`);
  return row;
};

describe("@lando/service-lando README — framework presets table", () => {
  test("README exists at the package root", async () => {
    const contents = await readReadme();
    expect(contents.length).toBeGreaterThan(0);
  });

  test("documents a Framework presets table", async () => {
    const table = findFrameworkTable(await readReadme());
    expect(table).toMatch(/\|\s*Type\s*\|/);
    expect(table).toMatch(/\|\s*Supported\s+`framework:`\s+values\s*\|/);
  });

  test("includes a row for every language ServiceType with the supported framework values", async () => {
    const table = findFrameworkTable(await readReadme());
    const expectations: ReadonlyArray<{
      language: string;
      frameworks: ReadonlyArray<string>;
    }> = [
      {
        language: "php",
        frameworks: [],
      },
      {
        language: "node",
        frameworks: ["none"],
      },
      {
        language: "python",
        frameworks: SUPPORTED_PYTHON_FRAMEWORKS,
      },
      {
        language: "ruby",
        frameworks: SUPPORTED_RUBY_FRAMEWORKS,
      },
      {
        language: "go",
        frameworks: SUPPORTED_GO_FRAMEWORKS,
      },
    ];

    for (const expectation of expectations) {
      const row = findLanguageRow(table, expectation.language);
      for (const framework of expectation.frameworks) {
        expect(row).toContain(`\`${framework}\``);
      }
    }
  });

  test("documents Node inference instead of schema-compatibility ignore", async () => {
    const table = findFrameworkTable(await readReadme());
    const nodeRow = findLanguageRow(table, "node");

    expect(nodeRow).toContain("inferred");
    expect(nodeRow).toContain("`none`");
    expect(nodeRow).toContain("packageRoot");
    expect(nodeRow).not.toContain("rejected");
    expect(nodeRow).not.toContain("accepted for schema compatibility");
  });

  test("documents explicit PHP webroot and AllowOverride parameters instead of presets", async () => {
    const phpRow = findLanguageRow(findFrameworkTable(await readReadme()), "php");

    expect(phpRow).toContain("webroot:");
    expect(phpRow).toContain("allowOverride:");
    expect(phpRow).toContain("n/a");
  });

  test("Go row lists only `none` and omits deferred frameworks", async () => {
    const table = findFrameworkTable(await readReadme());
    const goRow = findLanguageRow(table, "go");

    expect(goRow).toContain("`none`");
    expect(goRow).not.toMatch(/`echo`/);
    expect(goRow).not.toMatch(/`fiber`/);
    expect(goRow).not.toMatch(/`gin`/);
    expect(goRow).not.toMatch(/`chi`/);

    const readme = await readReadme();
    expect(readme).toMatch(/Echo/);
    expect(readme).toMatch(/Fiber/);
    expect(readme).toMatch(/Echo/);
    expect(readme).toMatch(/Fiber/);
  });
});
