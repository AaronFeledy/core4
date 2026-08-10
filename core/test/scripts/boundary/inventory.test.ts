import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  BOUNDARY_RULE_IDS,
  BOUNDARY_RULE_REGISTRATIONS,
  indexBoundaryRuleRegistrations,
} from "../../../../scripts/boundary/registry.ts";
import type { BoundaryRule } from "../../../../scripts/boundary/types.ts";

const inventoryPath = join(import.meta.dirname, "../../../../scripts/boundary/README.md");
const inventoryFile = Bun.file(inventoryPath);
const repositoryInstructionsFile = Bun.file(join(import.meta.dirname, "../../../../AGENTS.md"));

type InventoryRow = {
  readonly id: string;
  readonly kind: string;
  readonly ban: string;
  readonly packageEdge: string;
  readonly verdict: string;
  readonly justification: string;
};

const inventoryRows = async (): Promise<readonly InventoryRow[]> => {
  expect(await inventoryFile.exists(), "scripts/boundary/README.md must exist").toBe(true);
  const text = await inventoryFile.text();
  return text
    .split("\n")
    .filter((line) => /^\| `[^`]+` \|/u.test(line))
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const [rule, kind, ban, packageEdge, verdict, justification] = cells;
      if (
        rule === undefined ||
        kind === undefined ||
        ban === undefined ||
        packageEdge === undefined ||
        verdict === undefined ||
        justification === undefined
      ) {
        throw new TypeError(`Invalid boundary inventory row: ${line}`);
      }
      return {
        id: rule.replaceAll("`", ""),
        kind: kind.replaceAll("`", ""),
        ban,
        packageEdge,
        verdict: verdict.replaceAll("`", ""),
        justification,
      };
    });
};

const registrationJustifications = (): ReadonlyMap<string, string> =>
  new Map(
    BOUNDARY_RULE_REGISTRATIONS.map(({ rule, seamJustification }) => [rule.id, seamJustification] as const),
  );

describe("boundary rule inventory", () => {
  test("documents the scanner retirement ratchet in the boundary inventory", async () => {
    // Given: the maintained boundary inventory.
    const text = await inventoryFile.text();

    // When / Then: the scanner-retirement policy has a stable review heading.
    expect(text).toContain("## Scanner retirement ratchet");
  });

  test("documents the scanner-retirement ratchet in repository instructions", async () => {
    // Given: the root repository instructions.
    const text = await repositoryInstructionsFile.text();

    // When / Then: the compact architecture policy names the ratchet explicitly.
    expect(text).toContain("Scanner-retirement ratchet");
  });

  test("requires a non-empty seam justification for every boundary rule registration", () => {
    // Given: every canonical boundary rule registration.
    const registrationsWithoutJustification = BOUNDARY_RULE_REGISTRATIONS.filter(
      ({ seamJustification }) => seamJustification.trim().length === 0,
    );

    // When / Then: no registration can omit its seam-impossibility argument.
    expect(registrationsWithoutJustification.map(({ rule }) => rule.id)).toEqual([]);
  });

  test("rejects duplicate boundary rule registrations before indexing", () => {
    // Given: two registrations claiming the same boundary rule id.
    const duplicateRule = {
      id: "duplicate",
      scope: { roots: [], extensions: [] },
      carveOuts: { files: [], prefixes: [] },
      passMessage: "passes",
      failureHeadline: "fails",
    } as const satisfies BoundaryRule;
    const registrations = [
      { rule: duplicateRule, seamJustification: "first" },
      { rule: duplicateRule, seamJustification: "second" },
    ] as const;

    // When / Then: registry indexing rejects the duplicate instead of overwriting it.
    expect(() => indexBoundaryRuleRegistrations(registrations)).toThrow(
      "Duplicate boundary rule id: duplicate",
    );
  });

  test("covers every registered boundary rule exactly once", async () => {
    // Given: the canonical registry and its maintained inventory.
    const rows = await inventoryRows();

    // When: inventory rule ids are sorted for comparison.
    const inventoryIds = rows.map((row) => row.id).sort();

    // Then: no registered rule is missing or duplicated.
    expect(new Set(BOUNDARY_RULE_IDS).size).toBe(BOUNDARY_RULE_IDS.length);
    expect(inventoryIds).toEqual([...BOUNDARY_RULE_IDS].sort());
  });

  test("uses complete keep thin delete classification rows", async () => {
    // Given: every parsed inventory row.
    const rows = await inventoryRows();

    // When: validating each structured classification field.
    const invalidRows = rows.filter(
      (row) =>
        !["keep", "thin", "delete"].includes(row.verdict) ||
        row.kind.length === 0 ||
        row.ban.length === 0 ||
        row.packageEdge.length === 0 ||
        row.justification.length === 0,
    );

    // Then: every rule has a complete valid classification.
    expect(invalidRows).toEqual([]);
  });

  test("registers one seam-first justification per inventory rule", async () => {
    // Given: the maintained inventory from the seam-thinning audit.
    const rows = await inventoryRows();

    // When: canonical registrations are projected to their review justifications.
    const registered = registrationJustifications();

    // Then: registration and inventory carry the same complete policy.
    expect(registered).toEqual(new Map(rows.map((row) => [row.id, row.justification])));
  });

  test("marks behavioral survivors and records the retired engine-owned layering alias", async () => {
    // Given: the survivor classes named by the boundary inventory contract.
    const behavioralIds = [
      "renderer",
      "probe",
      "redaction",
      "managed-file",
      "libpod-prefix",
      "network",
    ] as const;
    const rows = await inventoryRows();
    const byId = new Map(rows.map((row) => [row.id, row]));

    // When / Then: behavioral rules stay explicit and the retired rule is no longer live.
    for (const id of behavioralIds) expect(byId.get(id)?.kind).toBe("behavioral");
    expect(byId.has("core-layering")).toBe(false);

    const text = await inventoryFile.text();
    expect(text).toContain("## Retired rule aliases");
    expect(text).toContain("`core-layering`");
    expect(text).toContain("`check:core-layering-boundary` → `check:package-dag`");
  });
});
