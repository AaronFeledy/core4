import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runArchitectureChecks } from "../../../../scripts/architecture/runner.ts";
import type { Rule } from "../../../../scripts/architecture/types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-architecture-runner-"));
  roots.push(root);
  await mkdir(join(root, "core/src"), { recursive: true });
  await writeFile(join(root, "core/src/one.ts"), "export const one = 1;\n");
  await writeFile(join(root, "core/src/two.ts"), "export const two = 2;\n");
  return root;
};

describe("runArchitectureChecks", () => {
  it("collects diagnostics by rule when injected rules run", async () => {
    // Given
    const root = await fixtureRoot();
    const rules = [
      {
        id: "renderer-boundary",
        title: "Renderer boundary",
        failureHeadline: "Renderer failed.",
        async run(context) {
          const [file] = await context.files("core-and-plugin-sources");
          if (file === undefined) return [];
          return [{ ruleId: "renderer-boundary", file: file.relativePath, message: "offender" }];
        },
      },
    ] satisfies ReadonlyArray<Rule>;

    // When
    const result = await runArchitectureChecks({ root, rules, auditExceptions: false });

    // Then
    expect(result).toMatchObject({ ok: false, filesScanned: 2 });
    expect(result.byRule.get("renderer-boundary")).toEqual(result.diagnostics);
  });

  it("uses the full inventory when rules do not request a selector", async () => {
    // Given
    const root = await fixtureRoot();
    const rules = [
      {
        id: "import-cycle",
        title: "Import cycle",
        failureHeadline: "Import cycle failed.",
        async run() {
          return [];
        },
      },
    ] satisfies ReadonlyArray<Rule>;

    // When
    const result = await runArchitectureChecks({ root, rules, auditExceptions: false });

    // Then
    expect(result).toMatchObject({ ok: true, filesScanned: 2, diagnostics: [] });
  });
});
