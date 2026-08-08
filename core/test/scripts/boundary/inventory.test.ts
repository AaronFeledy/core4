import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { BOUNDARY_RULE_IDS } from "../../../../scripts/boundary/registry.ts";

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

  test("marks behavioral survivors and retires engine-owned layering", async () => {
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

    // When / Then: behavioral rules stay explicit and the engine seam replaces core-layering.
    for (const id of behavioralIds) expect(byId.get(id)?.kind).toBe("behavioral");
    expect(byId.get("core-layering")).toMatchObject({ kind: "ownership", verdict: "delete" });
    expect(byId.get("core-layering")?.packageEdge).toContain("@lando/engine");
  });
});
