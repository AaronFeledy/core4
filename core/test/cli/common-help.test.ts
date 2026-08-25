import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { COMMON_COMMAND_IDS, commonRows, renderColdRootHelp } from "../../src/cli/cold-path-output.ts";
import { COMMAND_REGISTRY_MANIFEST } from "../../src/cli/generated/command-registry-manifest.ts";

const cliEntry = resolve(import.meta.dirname, "../../..", "core/bin/lando.ts");

const EXPECTED_COMMON_PRIMARIES = [
  "start",
  "stop",
  "restart",
  "rebuild",
  "destroy",
  "info",
  "logs",
  "exec",
  "ssh",
  "init",
  "list",
  "setup",
  "doctor",
] as const;

const sectionLines = (help: string, heading: string, nextHeadings: readonly string[]): readonly string[] => {
  const lines = help.split("\n");
  const start = lines.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const end = nextHeadings
    .map((headingName) => lines.indexOf(headingName, start + 1))
    .filter((index) => index > start)
    .toSorted((left, right) => left - right)[0];
  expect(end).toBeGreaterThan(start);
  return lines.slice(start + 1, end).filter((line) => line.trim() !== "");
};

const primaryOf = (line: string): string => {
  const match = /^\s+(\S+)/.exec(line);
  expect(match?.[1]).toBeDefined();
  return match?.[1] ?? "";
};

const runCli = async (argv: ReadonlyArray<string>) => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...argv],
    cwd: resolve(import.meta.dirname, "../../.."),
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

describe("COMMON help rows", () => {
  test("Given the command catalog, when commonRows is built, then everyday commands appear in display order", () => {
    // Given / When
    const rows = commonRows();

    // Then
    expect(rows.map((row) => row.canonicalId)).toEqual([...COMMON_COMMAND_IDS]);
    expect(rows.map((row) => row.primary)).toEqual([...EXPECTED_COMMON_PRIMARIES]);
    expect(rows[0]?.summary).toBe("Start the current Lando app.");
    expect(rows[9]?.summary).toBe("Generate a new Lando app.");
    expect(rows[12]?.summary).toBe(
      "Run diagnostics for app config, host/provider setup, and plugin-contributed checks.",
    );
  });

  test("Given the generated manifest, when COMMON ids are read, then each command is present and visible", () => {
    // Given / When / Then
    for (const id of COMMON_COMMAND_IDS) {
      const entry = COMMAND_REGISTRY_MANIFEST.commands[id];
      expect(entry).toBeDefined();
      expect(entry.hidden).toBe(false);
    }
  });

  test("Given live command specs, when helpGroup common is declared, then it matches COMMON_COMMAND_IDS", () => {
    // Given
    const tagged = builtInCommandEntries
      .filter((entry) => entry.spec.helpGroup === "common")
      .map((entry) => entry.spec.id)
      .toSorted();

    // When / Then
    expect(tagged).toEqual([...COMMON_COMMAND_IDS].toSorted());
  });

  test("Given unstyled root help, when COMMON is rendered, then each everyday command is a row before MORE", () => {
    // Given / When
    const help = renderColdRootHelp(undefined, { style: false });
    const rows = sectionLines(help, "COMMON", ["THIS APP", "MORE"]);

    // Then
    expect(rows.map(primaryOf)).toEqual([...EXPECTED_COMMON_PRIMARIES]);
    expect(rows[0]).toContain("Start the current Lando app.");
    expect(rows.some((row) => row.includes("meta:plugin:login"))).toBe(false);
  });

  test("Given the CLI, when --help is requested, then COMMON lists the everyday commands", async () => {
    // Given / When
    const result = await runCli(["--help"]);
    const rows = sectionLines(result.stdout, "COMMON", ["THIS APP", "MORE"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(rows.map(primaryOf)).toEqual([...EXPECTED_COMMON_PRIMARIES]);
    expect(rows[0]).toContain("Start the current Lando app.");
  });
});
