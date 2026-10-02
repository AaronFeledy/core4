import { expect, test } from "bun:test";
import type { ListFilter } from "@lando/sdk/services";

test("accepts opt-in unplanned discovery while preserving the default filter", () => {
  // Given
  const defaultFilter: ListFilter = {};
  const discoveryFilter: ListFilter = { includeUnplanned: true };
  // When
  const enabled: boolean | undefined = discoveryFilter.includeUnplanned;
  // Then
  expect(enabled).toBe(true);
  expect(defaultFilter.includeUnplanned).toBeUndefined();
});
