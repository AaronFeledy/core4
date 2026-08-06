import { describe, expect, test } from "bun:test";

import { parseEnvFile } from "../src/env-file.ts";

describe("parseEnvFile", () => {
  test("parses comments, export prefixes, quotes, CRLF, and equals signs", () => {
    // Given
    const content = [
      "# comment",
      "",
      "export PLAIN=value",
      'DOUBLE="two words"',
      "SINGLE='three words'",
      "URL=https://example.test/?left=right",
      "LITERAL=$HOST_VALUE",
    ].join("\r\n");

    // When
    const result = parseEnvFile(content, "/app/runtime.env");

    // Then
    expect(result).toEqual({
      ok: true,
      environment: {
        PLAIN: "value",
        DOUBLE: "two words",
        SINGLE: "three words",
        URL: "https://example.test/?left=right",
        LITERAL: "$HOST_VALUE",
      },
    });
  });

  test("parses Compose inline comments without stripping literal hashes", () => {
    // Given
    const content = [
      "UNQUOTED=value # comment",
      "LITERAL=value#not-a-comment",
      'QUOTED="value # literal"',
      'QUOTED_COMMENT="value" # comment',
    ].join("\n");

    // When
    const result = parseEnvFile(content, "/app/comments.env");

    // Then
    expect(result).toEqual({
      ok: true,
      environment: {
        UNQUOTED: "value",
        LITERAL: "value#not-a-comment",
        QUOTED: "value # literal",
        QUOTED_COMMENT: "value",
      },
    });
  });

  test("reports the source and line for malformed entries", () => {
    // Given
    const content = "VALID=yes\nMISSING_SEPARATOR";

    // When
    const result = parseEnvFile(content, "/app/broken.env");

    // Then
    expect(result).toEqual({
      ok: false,
      issue: {
        source: "/app/broken.env",
        line: 2,
        message: "Expected KEY=VALUE.",
      },
    });
  });

  test("rejects the reserved __proto__ key instead of silently dropping it", () => {
    // Given
    const content = "SAFE=yes\n__proto__=polluted";

    // When
    const result = parseEnvFile(content, "/app/reserved.env");

    // Then
    expect(result).toEqual({
      ok: false,
      issue: {
        source: "/app/reserved.env",
        line: 2,
        message: 'The environment variable name "__proto__" is reserved.',
      },
    });
  });

  test("rejects unterminated quoted values", () => {
    // Given
    const content = 'BROKEN="unterminated';

    // When
    const result = parseEnvFile(content, "/app/quoted.env");

    // Then
    expect(result).toEqual({
      ok: false,
      issue: {
        source: "/app/quoted.env",
        line: 1,
        message: "Quoted values must end with the matching quote.",
      },
    });
  });
});
