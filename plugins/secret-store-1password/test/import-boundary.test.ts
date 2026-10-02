import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { collectImportBoundaryViolations } from "@lando/sdk/test";

test("plugin stays within its declared import boundary", async () => {
  // Given
  const packageRoot = resolve(import.meta.dir, "..");
  // When
  const violations = await collectImportBoundaryViolations({ packageRoot });
  // Then
  expect(violations).toEqual([]);
});
