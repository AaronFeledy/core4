import { describe, expect, test } from "bun:test";

import {
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "@lando/sdk/landofile";

describe("compose tag dispositions", () => {
  test("normalizes Compose layer override tags through native layer merging", () => {
    expect(Object.keys(composeTagDispositions).sort()).toEqual(["!override", "!reset"]);

    for (const entry of Object.values(composeTagDispositions)) {
      expect(entry.disposition).toBe("normalized");
      expect(entry.rationale.length).toBeGreaterThan(0);
      expect(entry.remediation).toBeUndefined();
    }
  });

  test("keeps YAML tags isolated from schema-key disposition matrices", () => {
    expect(Object.keys(composeServiceDispositions).some((path) => path.startsWith("!"))).toBe(false);
    expect(Object.keys(composeTopLevelDispositions).some((path) => path.startsWith("!"))).toBe(false);
  });
});
