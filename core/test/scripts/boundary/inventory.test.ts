import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import * as boundaryRegistry from "../../../../scripts/boundary/registry.ts";

const { BOUNDARY_RULE_IDS } = boundaryRegistry;

const inventoryPath = join(import.meta.dirname, "../../../../scripts/boundary/README.md");
const inventoryFile = Bun.file(inventoryPath);

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

const property = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const registrationJustifications = (): ReadonlyMap<string, string> => {
  const registrations = property(boundaryRegistry, "BOUNDARY_RULE_REGISTRATIONS");
  if (!Array.isArray(registrations)) return new Map();

  return new Map(
    registrations.flatMap((registration) => {
      const rule = property(registration, "rule");
      const id = property(rule, "id");
      const seamJustification = property(registration, "seamJustification");
      return typeof id === "string" && typeof seamJustification === "string"
        ? ([[id, seamJustification]] as const)
        : [];
    }),
  );
};

describe("boundary rule inventory", () => {
  test("covers every registered boundary rule exactly once", async () => {
    // Given: the canonical registry and its maintained inventory.
    const rows = await inventoryRows();

    // When: inventory rule ids are sorted for comparison.
    const inventoryIds = rows.map((row) => row.id).sort();

    // Then: no registered rule is missing or duplicated.
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
