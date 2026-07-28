import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyExceptions,
  auditExceptions,
  isExceptionMatch,
  shouldAuditExceptions,
} from "../../../../scripts/architecture/exceptions.ts";
import type { ArchitectureException, Diagnostic } from "../../../../scripts/architecture/types.ts";

const temporaryRoots: string[] = [];

const createFixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-architecture-exceptions-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "core/src"), { recursive: true });
  await writeFile(join(root, "core/src/existing.ts"), "export const existing = true;\n");
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("architecture exceptions", () => {
  it("matches only the exact path when the exception kind is file", () => {
    // Given
    const exception = {
      ruleId: "renderer-boundary",
      path: "core/src/exact.ts",
      kind: "file",
      category: "carve-out",
      rationale: "Fixture carve-out.",
      removalCondition: "Remove after the fixture migrates.",
    } satisfies ArchitectureException;

    // When
    const matches = isExceptionMatch(exception, "core/src/exact.ts");

    // Then
    expect(matches).toBe(true);
  });

  it("does not match descendants when the exception kind is file", () => {
    // Given
    const exception = {
      ruleId: "renderer-boundary",
      path: "core/src/exact.ts",
      kind: "file",
      category: "carve-out",
      rationale: "Fixture carve-out.",
      removalCondition: "Remove after the fixture migrates.",
    } satisfies ArchitectureException;

    // When
    const matches = isExceptionMatch(exception, "core/src/exact.ts/nested.ts");

    // Then
    expect(matches).toBe(false);
  });

  it("matches descendants when the exception kind is prefix", () => {
    // Given
    const exception = {
      ruleId: "managed-file-boundary",
      path: "core/src/managed-file/",
      kind: "prefix",
      category: "owner",
      rationale: "Fixture owner.",
      removalCondition: "never — this is the primitive",
    } satisfies ArchitectureException;

    // When
    const matches = isExceptionMatch(exception, "core/src/managed-file/marker.ts");

    // Then
    expect(matches).toBe(true);
  });

  it("tracks every exception that suppresses a diagnostic", () => {
    // Given
    const fileException = {
      ruleId: "renderer-boundary",
      path: "core/src/owned.ts",
      kind: "file",
      category: "carve-out",
      rationale: "Fixture file carve-out.",
      removalCondition: "Remove after migration.",
    } satisfies ArchitectureException;
    const prefixException = {
      ruleId: "renderer-boundary",
      path: "core/src/",
      kind: "prefix",
      category: "carve-out",
      rationale: "Fixture prefix carve-out.",
      removalCondition: "Remove after migration.",
    } satisfies ArchitectureException;
    const diagnostics = [
      {
        ruleId: "renderer-boundary",
        file: "core/src/owned.ts",
        message: "Direct output.",
      },
      {
        ruleId: "network-boundary",
        file: "core/src/owned.ts",
        message: "Direct network access.",
      },
    ] satisfies ReadonlyArray<Diagnostic>;

    // When
    const result = applyExceptions(diagnostics, [fileException, prefixException]);

    // Then
    expect(result.diagnostics).toEqual(diagnostics.slice(1));
    expect(result.usedExceptions).toEqual(new Set([fileException, prefixException]));
  });

  it("reports a missing exception path against fixture inventory", async () => {
    // Given
    const root = await createFixtureRoot();
    const exception = {
      ruleId: "renderer-boundary",
      path: "core/src/missing.ts",
      kind: "file",
      category: "carve-out",
      rationale: "Fixture carve-out.",
      removalCondition: "Remove after migration.",
    } satisfies ArchitectureException;

    // When
    const stale = await auditExceptions(root, [exception], new Set());

    // Then
    expect(stale.map(({ kind }) => kind)).toContain("stale-missing");
  });

  it("reports an existing exception that suppresses nothing", async () => {
    // Given
    const root = await createFixtureRoot();
    const exception = {
      ruleId: "renderer-boundary",
      path: "core/src/existing.ts",
      kind: "file",
      category: "carve-out",
      rationale: "Fixture carve-out.",
      removalCondition: "Remove after migration.",
    } satisfies ArchitectureException;

    // When
    const stale = await auditExceptions(root, [exception], new Set());

    // Then
    expect(stale.map(({ kind }) => kind)).toContain("stale-unused");
  });

  it("allows an existing exception to suppress nothing when policy permits it", async () => {
    // Given
    const root = await createFixtureRoot();
    const exception = {
      ruleId: "renderer-boundary",
      path: "core/src/existing.ts",
      kind: "file",
      category: "carve-out",
      rationale: "Documented fixture carve-out with no current diagnostics.",
      removalCondition: "Remove after migration.",
      unusedPolicy: "allow",
    } satisfies ArchitectureException;

    // When
    const stale = await auditExceptions(root, [exception], new Set());

    // Then
    expect(stale).toEqual([]);
  });

  it("does not let unusedPolicy allow silence a missing path", async () => {
    // Given
    const root = await createFixtureRoot();
    const exception = {
      ruleId: "renderer-boundary",
      path: "core/src/missing.ts",
      kind: "file",
      category: "carve-out",
      rationale: "Documented fixture carve-out with no current diagnostics.",
      removalCondition: "Remove after migration.",
      unusedPolicy: "allow",
    } satisfies ArchitectureException;

    // When
    const stale = await auditExceptions(root, [exception], new Set());

    // Then
    expect(stale.map(({ kind }) => kind)).toEqual(["stale-missing"]);
  });

  it("audits exceptions only at the repository root", () => {
    // Given
    const root = "/repo";

    // When
    const shouldAudit = shouldAuditExceptions(root, root);

    // Then
    expect(shouldAudit).toBe(true);
  });
});
