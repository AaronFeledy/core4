import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import { McpConfig, McpServeOptions } from "@lando/sdk/schema";

describe("MCP concurrency schemas", () => {
  test("mcp-config-max-concurrent accepts positive integers", () => {
    // Given
    const input = { maxConcurrent: 8 };

    // When
    const decoded = Schema.decodeUnknownResult(McpConfig)(input, { onExcessProperty: "error" });

    // Then
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  test("mcp-serve-max-concurrent rejects zero", () => {
    // Given
    const input = { transport: "stdio", maxConcurrent: 0 };

    // When
    const decoded = Schema.decodeUnknownResult(McpServeOptions)(input, {
      onExcessProperty: "error",
    });

    // Then
    expect(Result.isFailure(decoded)).toBe(true);
  });
});
