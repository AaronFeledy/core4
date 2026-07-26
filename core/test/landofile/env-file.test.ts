import { describe, expect, test } from "bun:test";

import { parseEnvFile } from "../../src/landofile/env-file.ts";

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
