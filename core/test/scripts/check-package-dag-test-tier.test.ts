import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type PackageDagFixture, createPackageDagFixture } from "./package-dag-fixture.ts";

let fixture: PackageDagFixture;

const engineDefinition = {
  dependencies: {
    "@lando/container-runtime": "workspace:*",
    "@lando/landofile": "workspace:*",
    "@lando/paths": "workspace:*",
    "@lando/sdk": "workspace:*",
    "@lando/state-store": "workspace:*",
  },
  exports: {
    ".": "./src/index.ts",
    "./public": "./src/public.ts",
    "./*": "./src/*.ts",
  },
} as const;

const writeEngineExports = async (): Promise<void> => {
  await fixture.writePackage("engine", "@lando/engine", engineDefinition);
};

beforeEach(async () => {
  fixture = await createPackageDagFixture();
});

afterEach(async () => {
  await fixture.dispose();
});

describe("check-package-dag test-tier policy", () => {
  test("allows a foreign package root export", async () => {
    // Given
    await writeEngineExports();
    await fixture.write("core/test/root.test.ts", 'import "@lando/engine";\n');

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "Package DAG violations: 0\n", stderr: "" });
  });

  test("allows an exact named exports subpath", async () => {
    // Given
    await writeEngineExports();
    await fixture.write("core/test/public.test.ts", 'import "@lando/engine/public";\n');

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "Package DAG violations: 0\n", stderr: "" });
  });

  test("rejects a foreign subpath exposed only by a wildcard export", async () => {
    // Given
    await writeEngineExports();
    await fixture.write("core/test/private.test.ts", 'import "@lando/engine/private";\n');

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain(
      "core/test/private.test.ts:1: [PackageDagDetachedTestEdge] @lando/core test -> @lando/engine/private. Remediation: move this test into @lando/engine/test, or import @lando/engine through its root export or a named exports subpath.",
    );
  });

  test("allows own-package deep imports by relative path and package name", async () => {
    // Given
    await fixture.write(
      "core/test/own.test.ts",
      'import "../src/internal.ts";\nimport "@lando/core/src/internal.ts";\n',
    );

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "Package DAG violations: 0\n", stderr: "" });
  });

  test("ignores node, Effect, and npm package imports", async () => {
    // Given
    await fixture.write(
      "core/test/external.test.ts",
      'import "node:path";\nimport "effect";\nimport "effect/Schema";\nimport "third-party-package";\n',
    );

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "Package DAG violations: 0\n", stderr: "" });
  });

  test("rejects a relative import escaping into a sibling package", async () => {
    // Given
    await fixture.write("core/test/escape.test.ts", 'import "../../engine/src/internal.ts";\n');

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain(
      "core/test/escape.test.ts:1: [PackageDagDetachedTestEdge] @lando/core test -> ../../engine/src/internal.ts. Remediation: move this test into @lando/engine/test, or import @lando/engine through its root export or a named exports subpath.",
    );
  });

  test("allows a relative import escaping to a repo-root non-package path", async () => {
    // Given
    await Promise.all([
      fixture.write("core/test/root-script.test.ts", 'import "../../scripts/root-helper.ts";\n'),
      fixture.write("scripts/root-helper.ts", "export {};\n"),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "Package DAG violations: 0\n", stderr: "" });
  });

  test.each([
    ["dynamic import", 'void import("SPECIFIER");'],
    ["require", 'require("SPECIFIER");'],
    ["export-from", 'export * from "SPECIFIER";'],
  ])("applies the same public-entrypoint verdict to %s", async (_kind, source) => {
    // Given
    await writeEngineExports();
    await Promise.all([
      fixture.write(
        "core/test/public-form.test.ts",
        `${source.replace("SPECIFIER", "@lando/engine/public")}\n`,
      ),
      fixture.write(
        "core/test/private-form.test.ts",
        `${source.replace("SPECIFIER", "@lando/engine/private")}\n`,
      ),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).not.toContain("core/test/public-form.test.ts");
    expect(result.stdout).toContain("core/test/private-form.test.ts:1: [PackageDagDetachedTestEdge]");
  });

  test.each(["ts", "tsx", "mts", "cts"])(
    "rejects foreign deep imports from .%s test modules",
    async (extension) => {
      // Given
      await writeEngineExports();
      await fixture.write(`core/test/deep.test.${extension}`, 'import "@lando/engine/private";\n');

      // When
      const result = await fixture.runGate(["--report"]);

      // Then
      expect(result.stdout).toContain(`core/test/deep.test.${extension}:1: [PackageDagDetachedTestEdge]`);
    },
  );

  test("reports a package with source and no test tree at its manifest", async () => {
    // Given
    await Promise.all([
      fixture.writeRoot(["missing"]),
      fixture.writePackage("missing", "@lando/paths", { withoutTests: true }),
      fixture.write("missing/src/index.ts", "export {};\n"),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain(
      "missing/package.json:1: [PackageDagMissingTestTree] missing has src/ but no tests. Remediation: add tests under missing/test/.",
    );
  });

  test.each(["ts", "tsx", "mts", "cts"])(
    "accepts a nested .test.%s file as package test presence",
    async (extension) => {
      // Given
      await Promise.all([
        fixture.writeRoot(["covered"]),
        fixture.writePackage("covered", "@lando/paths", { withoutTests: true }),
        fixture.write("covered/src/index.ts", "export {};\n"),
        fixture.write(`covered/test/nested/presence.test.${extension}`, "export {};\n"),
      ]);

      // When
      const result = await fixture.runGate(["--report"]);

      // Then
      expect(result).toEqual({ exitCode: 0, stdout: "Package DAG violations: 0\n", stderr: "" });
    },
  );

  test("offers no suppression mechanism for a foreign private subpath", async () => {
    // Given
    await writeEngineExports();
    const retiredLedgerPath = [
      "scripts/boundary",
      `${["detached", "tests", "baseline"].join("-")}.json`,
    ].join("/");
    await Promise.all([
      fixture.write("core/test/private.test.ts", 'import "@lando/engine/private";\n'),
      fixture.write(
        retiredLedgerPath,
        `${JSON.stringify({
          note: "retired suppression ledger",
          testTierEdges: [{ file: "core/test/private.test.ts", specifier: "@lando/engine/private" }],
          packagesWithoutTests: [],
        })}\n`,
      ),
    ]);

    // When
    const result = await fixture.runGate([]);

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("core/test/private.test.ts:1: [PackageDagDetachedTestEdge]");
  });
});
