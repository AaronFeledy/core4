import { describe, expect, test } from "bun:test";
import { RecipeSourceError, StateStoreError } from "@lando/sdk/errors";
import { SourceAcquisitionError } from "@lando/source-acquisition";
import { mapSourceAcquisitionError } from "../../src/recipes/source-session.ts";

describe("mapSourceAcquisitionError store mapping", () => {
  test("preserves newer-version upgrade remediation from a raw StateStoreError", () => {
    const cause = new StateStoreError({
      reason: "newer-version",
      operation: "get",
      path: "/cache/sources/index.json",
      storedVersion: 4,
      supportedVersion: 1,
      remediation:
        "A newer Lando wrote /cache/sources/index.json (envelope version 4; this Lando supports 1). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place: replacing or deleting it would discard state the newer Lando depends on.",
    });
    const mapped = mapSourceAcquisitionError(cause, "npm");
    expect(mapped).toBeInstanceOf(RecipeSourceError);
    expect(mapped.kind).toBe("cache");
    expect(mapped.remediation).toBe(cause.remediation);
    expect(mapped.remediation).toContain("Leave the file in place");
    expect(mapped.remediation).not.toContain("Check the recipe source coordinates");
  });

  test("preserves remediation already mapped through SourceAcquisitionError", () => {
    const store = new StateStoreError({
      reason: "newer-version",
      operation: "get",
      path: "/cache/sources/index.json",
      storedVersion: 4,
      supportedVersion: 1,
      remediation:
        "A newer Lando wrote /cache/sources/index.json (envelope version 4; this Lando supports 1). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place: replacing or deleting it would discard state the newer Lando depends on.",
    });
    const mid = new SourceAcquisitionError({
      kind: "cache",
      source: "source store",
      message: store.message,
      remediation: store.remediation,
    });
    const mapped = mapSourceAcquisitionError(mid, "generic");
    expect(mapped.remediation).toBe(store.remediation);
  });
});
