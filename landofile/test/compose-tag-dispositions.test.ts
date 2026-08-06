import { describe, expect, test } from "bun:test";

import {
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "../src/compose/dispositions.ts";

describe("compose tag dispositions", () => {
  test("rejects Compose layer override tags with merge remediation", () => {
    expect(Object.keys(composeTagDispositions).sort()).toEqual(["!override", "!reset"]);

    for (const entry of Object.values(composeTagDispositions)) {
      expect(entry.disposition).toBe("rejected");
      expect(entry.rationale.length).toBeGreaterThan(0);
      expect(entry.remediation?.length).toBeGreaterThan(0);
      expect(entry.remediation).toContain("merge");
    }
  });

  test("keeps YAML tags isolated from schema-key disposition matrices", () => {
    expect(Object.keys(composeServiceDispositions).some((path) => path.startsWith("!"))).toBe(false);
    expect(Object.keys(composeTopLevelDispositions).some((path) => path.startsWith("!"))).toBe(false);
  });
});
