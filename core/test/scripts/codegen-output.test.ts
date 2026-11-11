import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CodegenOutputFormatError,
  CodegenOutputPathError,
  biomeCheckArgv,
  formatGeneratedPaths,
  writeFormattedOutput,
} from "../../../scripts/_codegen-output.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("writeFormattedOutput", () => {
  test("writes content and runs biome check --write on the output", async () => {
    tempRoot = await mkdtemp(join(repoRoot, "codegen-output-test-"));
    const output = join(tempRoot, "generated.ts");

    await writeFormattedOutput(output, "export const value={name:'demo'}\n");

    expect(await readFile(output, "utf8")).toBe('export const value = { name: "demo" };\n');
  }, 30_000);

  test("formats output under a gitignored directory", async () => {
    // Given
    const ignoredRoot = join(repoRoot, ".tmp");
    await mkdir(ignoredRoot, { recursive: true });
    tempRoot = await mkdtemp(join(ignoredRoot, "codegen-output-ignored-test-"));
    const output = join(tempRoot, "generated.ts");

    // When
    await writeFormattedOutput(output, "export const value={name:'demo'}\n");

    // Then
    expect(await readFile(output, "utf8")).toBe('export const value = { name: "demo" };\n');
  }, 30_000);

  test("sorts imports and removes unused imports from output", async () => {
    // Given
    tempRoot = await mkdtemp(join(repoRoot, "codegen-output-imports-test-"));
    const output = join(tempRoot, "generated.ts");

    // When
    await writeFormattedOutput(
      output,
      'import { b } from "./b";\nimport { a } from "./a";\nimport { unused } from "./c";\nexport const value = { a, b };\n',
    );

    // Then
    expect(await readFile(output, "utf8")).toBe(
      'import { a } from "./a";\nimport { b } from "./b";\nexport const value = { a, b };\n',
    );
  }, 30_000);

  test("rejects output Biome cannot parse", async () => {
    // Given
    tempRoot = await mkdtemp(join(repoRoot, "codegen-output-malformed-test-"));
    const output = join(tempRoot, "generated.ts");

    // When
    const write = writeFormattedOutput(output, "export const = ;\n");

    // Then
    await expect(write).rejects.toBeInstanceOf(CodegenOutputFormatError);
  }, 30_000);

  test("rejects an outside path before writing content", async () => {
    // Given
    tempRoot = await mkdtemp(join(tmpdir(), "codegen-output-outside-test-"));
    const output = join(tempRoot, "generated.ts");

    // When
    const write = writeFormattedOutput(output, "export const value = true;\n");

    // Then
    await expect(write).rejects.toBeInstanceOf(CodegenOutputPathError);
    expect(await Bun.file(output).exists()).toBe(false);
  });
});

describe("formatGeneratedPaths", () => {
  test("rejects a generated path Biome does not process", async () => {
    // Given
    tempRoot = await mkdtemp(join(repoRoot, "codegen-output-unmatched-test-"));
    const output = join(tempRoot, "generated.txt");
    await Bun.write(output, "plain text\n");

    // When
    const format = formatGeneratedPaths([output]);

    // Then
    await expect(format).rejects.toBeInstanceOf(CodegenOutputFormatError);
  }, 30_000);
});

describe("biomeCheckArgv", () => {
  test("normalizes absolute generated paths relative to the repository root", () => {
    // Given
    const output = resolve(repoRoot, "core/generated/example.ts");

    // When
    const argv = biomeCheckArgv([output]);

    // Then
    expect(argv).toEqual([
      process.execPath,
      "x",
      "biome",
      "check",
      "--write",
      "--vcs-use-ignore-file=false",
      "--",
      join("core", "generated", "example.ts"),
    ]);
  });

  test("rejects an empty generated path list", () => {
    // Given / When
    const buildArgv = (): readonly string[] => biomeCheckArgv([]);

    // Then
    expect(buildArgv).toThrow(CodegenOutputPathError);
  });

  test("rejects an empty generated path", () => {
    // Given / When
    const buildArgv = (): readonly string[] => biomeCheckArgv([""]);

    // Then
    expect(buildArgv).toThrow(CodegenOutputPathError);
  });

  test("rejects the repository root as a generated path", () => {
    // Given / When
    const buildArgv = (): readonly string[] => biomeCheckArgv([repoRoot]);

    // Then
    expect(buildArgv).toThrow(CodegenOutputPathError);
  });

  test("rejects a generated path outside the repository root", () => {
    // Given
    const outsidePath = resolve(repoRoot, "..", "outside.ts");

    // When
    const buildArgv = (): readonly string[] => biomeCheckArgv([outsidePath]);

    // Then
    expect(buildArgv).toThrow(CodegenOutputPathError);
  });

  test("does not silence unmatched generated paths", () => {
    // Given / When
    const argv = biomeCheckArgv([resolve(repoRoot, "dist/unmatched")]);

    // Then
    expect(argv).not.toContain("--no-errors-on-unmatched");
  });
});
