import { describe, expect, test } from "bun:test";

import { parseSubordinateIdFile, validateSubordinateIdRanges } from "../src/rootless-preflight.ts";

describe("parseSubordinateIdFile", () => {
  test("parses CRLF entries while ignoring blank lines, comments, and trailing whitespace", () => {
    // Given
    const text = "# managed allocations\r\n\r\nalice:100000:65536  \r\n bob : 200000 : 65536 \r\n";

    // When
    const entries = parseSubordinateIdFile(text);

    // Then
    expect(entries).toEqual([
      { user: "alice", start: 100000, count: 65536 },
      { user: "bob", start: 200000, count: 65536 },
    ]);
  });

  test("skips malformed entries without throwing", () => {
    // Given
    const text = [
      "missing-fields:100000",
      "too:many:fields:65536",
      "alice:not-a-number:65536",
      "bob:100000:not-a-number",
      "carol:300000:65536",
    ].join("\n");

    // When
    const entries = parseSubordinateIdFile(text);

    // Then
    expect(entries).toEqual([{ user: "carol", start: 300000, count: 65536 }]);
  });

  test("preserves duplicate entries for the same user", () => {
    // Given
    const text = "alice:100000:65536\nalice:100000:65536\n";

    // When
    const entries = parseSubordinateIdFile(text);

    // Then
    expect(entries).toHaveLength(2);
  });
});

describe("validateSubordinateIdRanges", () => {
  test("returns missing when the user has no allocation", () => {
    // Given
    const entries = parseSubordinateIdFile("bob:100000:65536\n");

    // When
    const verdict = validateSubordinateIdRanges(entries, "alice");

    // Then
    expect(verdict).toEqual({ kind: "missing" });
  });

  test("accepts one range with exactly 65536 IDs", () => {
    // Given
    const entries = parseSubordinateIdFile("alice:100000:65536\n");

    // When
    const verdict = validateSubordinateIdRanges(entries, "alice");

    // Then
    expect(verdict).toEqual({ kind: "ok" });
  });

  test("rejects one range with 65535 IDs", () => {
    // Given
    const entries = parseSubordinateIdFile("alice:100000:65535\n");

    // When
    const verdict = validateSubordinateIdRanges(entries, "alice");

    // Then
    expect(verdict).toEqual({ kind: "too-small", available: 65535 });
  });

  test("does not combine discontiguous ranges to satisfy the minimum", () => {
    // Given
    const entries = parseSubordinateIdFile("alice:100000:40000\nalice:200000:40000\n");

    // When
    const verdict = validateSubordinateIdRanges(entries, "alice");

    // Then
    expect(verdict).toEqual({ kind: "too-small", available: 40000 });
  });

  test("accepts adjacent allocations owned by different users", () => {
    // Given
    const entries = parseSubordinateIdFile("alice:100000:65536\nbob:165536:65536\n");

    // When
    const verdict = validateSubordinateIdRanges(entries, "alice");

    // Then
    expect(verdict).toEqual({ kind: "ok" });
  });

  test("reports the other user when allocations overlap", () => {
    // Given
    const entries = parseSubordinateIdFile("alice:100000:65536\nbob:165535:65536\n");

    // When
    const verdict = validateSubordinateIdRanges(entries, "alice");

    // Then
    expect(verdict).toEqual({ kind: "overlap", withUser: "bob" });
  });

  test("never reports a user's own multiple ranges as an overlap", () => {
    // Given
    const entries = parseSubordinateIdFile("alice:100000:65536\nalice:100001:65536\n");

    // When
    const verdict = validateSubordinateIdRanges(entries, "alice");

    // Then
    expect(verdict).toEqual({ kind: "ok" });
  });
});
