import { describe, expect, test } from "bun:test";

import { buildContainerRemoveRequest, isSuccessStatus } from "../src/engine-api.ts";

describe("engine API contracts", () => {
  test.each([
    ["owned-id", "/containers/owned-id?force=true&v=true"],
    ["raw/id%2F?#", "/containers/raw%2Fid%252F%3F%23?force=true&v=true"],
  ] as const)("removes anonymous volumes while encoding raw reference %s once", (reference, path) => {
    const request = buildContainerRemoveRequest(reference);
    expect(request).toEqual({ method: "DELETE", path });
  });
  test("recognizes only 2xx statuses as successful", () => {
    // Given
    const statuses = [199, 200, 299, 300] as const;

    // When
    const results = statuses.map(isSuccessStatus);

    // Then
    expect(results).toEqual([false, true, true, false]);
  });
});
