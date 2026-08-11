import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const agentsPath = resolve(repoRoot, "AGENTS.md");
const packagePath = resolve(repoRoot, "package.json");

type GateRow = readonly [gate: string, classification: string];

const parseGateRows = (markdown: string): ReadonlyArray<GateRow> => {
  const heading = "## Generated Files";
  const start = markdown.indexOf(heading);
  if (start === -1) return [];
  const remainder = markdown.slice(start + heading.length);
  const end = remainder.search(/^## /m);
  const section = end === -1 ? remainder : remainder.slice(0, end);

  return section.split("\n").flatMap((line): ReadonlyArray<GateRow> => {
    if (!line.startsWith("|")) return [];
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    const gate = cells[0]?.match(/`([^`]+)`/)?.[1];
    const classification = cells[1]?.toLowerCase();
    return gate === undefined || classification === undefined ? [] : [[gate, classification]];
  });
};

const rootScripts = async (): Promise<Readonly<Record<string, string>>> => {
  const value: unknown = await Bun.file(packagePath).json();
  if (typeof value !== "object" || value === null || !("scripts" in value)) {
    throw new TypeError("package.json must contain scripts");
  }
  const { scripts } = value;
  if (typeof scripts !== "object" || scripts === null) {
    throw new TypeError("package.json scripts must be an object");
  }
  const entries = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
};

const readGateRows = async (): Promise<ReadonlyArray<GateRow>> =>
  parseGateRows(await Bun.file(agentsPath).text());

describe("gate classification matrix", () => {
  test("classifies codegen:check as the sole pure-drift gate", async () => {
    // Given / When
    const rows = await readGateRows();
    const matrix = new Map(rows);

    // Then
    expect(rows.length, "expected a Gate/Class table under Generated Files").toBeGreaterThan(0);
    expect(matrix.get("codegen:check")).toBe("pure drift");
    expect(
      rows.filter(([, classification]) => classification === "pure drift").map(([gate]) => gate),
    ).toEqual(["codegen:check"]);
  });

  test("classifies the semantic correctness gates", async () => {
    // Given / When
    const matrix = new Map(await readGateRows());

    // Then
    expect(
      Object.fromEntries([...matrix].filter(([, classification]) => classification === "semantic")),
    ).toEqual({
      "check:guide-coverage": "semantic",
      "check:schema-compatibility": "semantic",
      "check:public-transcripts": "semantic",
      "check:boundaries": "semantic",
    });
  });

  test("uses a closed classification vocabulary with no duplicate gate rows", async () => {
    // Given / When
    const rows = await readGateRows();

    // Then
    expect(new Set(rows.map(([, classification]) => classification))).toEqual(
      new Set(["pure drift", "semantic"]),
    );
    expect(new Set(rows.map(([gate]) => gate)).size).toBe(rows.length);
  });

  test("names gates that resolve to real root scripts", async () => {
    // Given
    const scripts = await rootScripts();

    // When
    const literalGates = (await readGateRows()).map(([gate]) => gate).filter((gate) => !gate.includes("*"));

    // Then
    expect(literalGates.every((gate) => gate in scripts)).toBe(true);
  });

  test("keeps codegen drift wiring out of semantic gates", async () => {
    // Given
    const scripts = await rootScripts();
    const rows = await readGateRows();

    // When
    const semanticScripts = rows
      .filter(([gate, classification]) => classification === "semantic" && !gate.includes("*"))
      .map(([gate]) => scripts[gate]);

    // Then
    expect(scripts["codegen:check"]).toContain("check:codegen-drift");
    expect(semanticScripts.every((script) => !script?.includes("check:codegen-drift"))).toBe(true);
  });

  test("pins codegen:check ordered composite bun run steps", async () => {
    // Given
    const scripts = await rootScripts();
    const codegenCheck = scripts["codegen:check"];

    // When
    const orderedSteps = [...(codegenCheck?.matchAll(/bun run ([\w:*-]+)/g) ?? [])].map((match) => match[1]);

    // Then
    expect(orderedSteps).toEqual(["codegen", "check:codegen-drift"]);
  });

  test("keeps companion codegen:check steps out of pure-drift classification", async () => {
    // Given / When
    const matrix = new Map(await readGateRows());

    // Then
    expect(matrix.get("codegen:check")).toBe("pure drift");
    expect(matrix.get("check:codegen-drift")).not.toBe("pure drift");
    expect(matrix.get("check:deprecations")).not.toBe("pure drift");
    expect(matrix.get("typecheck")).not.toBe("pure drift");
    expect(matrix.get("codegen")).not.toBe("pure drift");
  });
});
