import { describe, expect, test } from "bun:test";

import {
  MAX_RETAINED_COMPLETED_REQUEST_IDS,
  emptyCompletedRequestIds,
  rememberCompletedRequestId,
} from "../../src/mcp/cancellation.ts";

describe("MCP completed request history", () => {
  test("evicts the oldest request id at the retained-history limit", () => {
    // Given
    const requestIds = Array.from(
      { length: MAX_RETAINED_COMPLETED_REQUEST_IDS + 1 },
      (_, index) => `request-${index}`,
    );

    // When
    const completed = requestIds.reduce(rememberCompletedRequestId, emptyCompletedRequestIds());

    // Then
    expect(completed.size).toBe(MAX_RETAINED_COMPLETED_REQUEST_IDS);
    expect(completed.has("request-0")).toBe(false);
    expect(completed.has(`request-${MAX_RETAINED_COMPLETED_REQUEST_IDS}`)).toBe(true);
  });
});
