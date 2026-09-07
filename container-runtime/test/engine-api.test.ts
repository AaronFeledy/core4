import { describe, expect, test } from "bun:test";

import { isSuccessStatus } from "../src/engine-api.ts";

describe("engine API contracts", () => {
  test("recognizes only 2xx statuses as successful", () => {
    // Given
    const statuses = [199, 200, 299, 300] as const;

    // When
    const results = statuses.map(isSuccessStatus);

    // Then
    expect(results).toEqual([false, true, true, false]);
  });
});
