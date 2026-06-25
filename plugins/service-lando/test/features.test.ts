import { describe, expect, test } from "bun:test";

import { SERVICE_FEATURE_IDS, serviceFeatures } from "../src/index.ts";

const EXPECTED_PRIORITIES: ReadonlyArray<readonly [string, number]> = [
  ["lando.user-id", 300],
  ["lando.storage", 500],
  ["lando.env", 700],
  ["lando.app-mount", 800],
  ["lando.healthcheck", 900],
  ["lando.user", 2000],
];

describe("@lando/service-lando built-in feature modules", () => {
  test("publishes each built-in lando.* feature at its canonical priority", () => {
    for (const [id, priority] of EXPECTED_PRIORITIES) {
      const definition = serviceFeatures.get(id);
      expect(definition).toBeDefined();
      expect(definition?.id).toBe(id);
      expect(definition?.priority).toBe(priority);
    }
  });

  test("manifest contributes exactly the published feature ids", () => {
    expect([...SERVICE_FEATURE_IDS].sort()).toEqual(EXPECTED_PRIORITIES.map(([id]) => id).sort());
    expect([...serviceFeatures.keys()].sort()).toEqual(SERVICE_FEATURE_IDS.slice().sort());
  });
});
