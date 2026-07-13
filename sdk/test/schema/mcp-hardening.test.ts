import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { McpConfig, McpServeOptions } from "@lando/sdk/schema";

describe("MCP concurrency schemas", () => {
  test("mcp-config-max-concurrent accepts positive integers", () => {
    // Given
    const input = { maxConcurrent: 8 };

    // When
    const decoded = Schema.decodeUnknownEither(McpConfig)(input, { onExcessProperty: "error" });

    // Then
    expect(Either.isRight(decoded)).toBe(true);
  });

  test("mcp-serve-max-concurrent rejects zero", () => {
    // Given
    const input = { transport: "stdio", maxConcurrent: 0 };

    // When
    const decoded = Schema.decodeUnknownEither(McpServeOptions)(input, {
      onExcessProperty: "error",
    });

    // Then
    expect(Either.isLeft(decoded)).toBe(true);
  });
});
