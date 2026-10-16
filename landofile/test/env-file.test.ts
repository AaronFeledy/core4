import { describe, expect, test } from "bun:test";

import { decodeDoubleQuotedEnvValue, parseEnvFile, warningsForEnvFileEntry } from "../src/env-file.ts";

const parsedEnvironment = (content: string, source = "/app/runtime.env") => {
  const result = parseEnvFile(content, source);
  expect(result.ok).toBe(true);
  if (!result.ok) return {};
  return result.environment;
};

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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environment).toEqual({
      PLAIN: "value",
      DOUBLE: "two words",
      SINGLE: "three words",
      URL: "https://example.test/?left=right",
      LITERAL: "$HOST_VALUE",
    });
    expect(result.warnings).toEqual([]);
  });

  test("parses inline comments without stripping literal hashes", () => {
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environment).toEqual({
      UNQUOTED: "value",
      LITERAL: "value#not-a-comment",
      QUOTED: "value # literal",
      QUOTED_COMMENT: "value",
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
        suggestion: 'environment: { MISSING_SEPARATOR: "{{ env.MISSING_SEPARATOR }}" }',
      },
    });
  });

  test("rejects a bare NAME line with environment interpolation remediation", () => {
    // Given / When
    const result = parseEnvFile("NAME", "/app/bare.env");

    // Then
    expect(result).toEqual({
      ok: false,
      issue: {
        source: "/app/bare.env",
        line: 1,
        message: "Expected KEY=VALUE.",
        suggestion: 'environment: { NAME: "{{ env.NAME }}" }',
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

  test("rejects a stray quote inside a double-quoted value", () => {
    // Given / When
    const result = parseEnvFile('B="a"b"', "/app/stray.env");

    // Then
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue).toEqual({
      source: "/app/stray.env",
      line: 1,
      message: "Quoted values must end with the matching quote.",
    });
  });

  test("accepts an escaped quote inside a double-quoted value", () => {
    // Given / When / Then
    expect(parsedEnvironment('B="a\\"b"').B).toBe('a"b');
  });

  test.each([
    ["\\a", "\x07"],
    ["\\b", "\b"],
    ["\\f", "\f"],
    ["\\n", "\n"],
    ["\\r", "\r"],
    ["\\t", "\t"],
    ["\\v", "\v"],
    ["\\$", "$"],
    ['\\"', '"'],
    ["\\\\", "\\"],
    ["\\0101", "A"],
  ] as const)("decodes double-quoted escape %s", (sequence, expected) => {
    // Given / When
    const environment = parsedEnvironment(`KEY="${sequence}"`);

    // Then
    expect(environment.KEY).toBe(expected);
  });

  test("keeps the backslash for double-quoted \\c and unknown escapes", () => {
    // Given / When / Then
    expect(parsedEnvironment('C="\\c"').C).toBe("\\c");
    expect(parsedEnvironment('X="\\x"').X).toBe("\\x");
    expect(parsedEnvironment('PATH="C:\\Users"').PATH).toBe("C:\\Users");
  });

  test("parses multi-line double-quoted values", () => {
    // Given
    const content = ['MULTI="line1', 'line2\\nline3"', "AFTER=ok"].join("\n");

    // When
    const result = parseEnvFile(content, "/app/multi.env");

    // Then
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environment.MULTI).toBe("line1\nline2\nline3");
    expect(result.environment.AFTER).toBe("ok");
    expect(result.entries[0]?.line).toBe(1);
    expect(result.warnings.some((warning) => warning.key === "MULTI")).toBe(true);
  });

  test("treats single-quoted \\' as a literal quote and leaves other backslashes", () => {
    // Given / When
    const environment = parsedEnvironment("S='it\\'s \\n fine'");

    // Then
    expect(environment.S).toBe("it's \\n fine");
  });

  test("keeps ${...} literal instead of interpolating", () => {
    // Given / When
    const result = parseEnvFile('HOME="${HOME}"\nPLAIN=${HOME}', "/app/interp.env");

    // Then
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.environment.HOME).toBe("${HOME}");
    expect(result.environment.PLAIN).toBe("${HOME}");
    expect(result.warnings).toEqual([
      {
        line: 1,
        key: "HOME",
        message: "Value for HOME contains ${, which env files do not interpolate.",
        suggestion:
          "Use single quotes or $$ if you want a literal dollar, or set the value in environment: with {{ env.* }}.",
      },
      {
        line: 2,
        key: "PLAIN",
        message: "Value for PLAIN contains ${, which env files do not interpolate.",
        suggestion:
          "Use single quotes or $$ if you want a literal dollar, or set the value in environment: with {{ env.* }}.",
      },
    ]);
  });

  test("does not treat a leading BOM as part of the first key", () => {
    // Given / When
    const environment = parsedEnvironment("\uFEFFPLAIN=value");

    // Then
    expect(environment.PLAIN).toBe("value");
  });
});

describe("decodeDoubleQuotedEnvValue", () => {
  test("decodes C:\\new as a changed Windows path", () => {
    // Given / When / Then
    expect(decodeDoubleQuotedEnvValue("C:\\new")).toBe("C:\new");
    expect(decodeDoubleQuotedEnvValue("C:\\new")).not.toBe("C:\\new");
  });
});

describe("warningsForEnvFileEntry", () => {
  test("warns when a double-quoted value decodes differently from its raw text", () => {
    // Given
    const entry = {
      key: "PATH",
      value: "C:\new",
      raw: "C:\\new",
      quote: '"' as const,
      line: 3,
    };

    // When
    const warnings = warningsForEnvFileEntry(entry);

    // Then
    expect(warnings).toEqual([
      {
        line: 3,
        key: "PATH",
        message: "Double-quoted value for PATH decodes differently from its raw text.",
        suggestion:
          "Quote the value with single quotes to keep the raw text, or write \\\\ for each backslash you want to keep.",
      },
    ]);
  });

  test("does not warn when single-quoted \\' is the only decode", () => {
    // Given
    const entry = {
      key: "S",
      value: "it's",
      raw: "it\\'s",
      quote: "'" as const,
      line: 1,
    };

    // When / Then
    expect(warningsForEnvFileEntry(entry)).toEqual([]);
  });

  test("warns on ${ in an env value", () => {
    // Given
    const entry = {
      key: "TOKEN",
      value: "${SECRET}",
      raw: "${SECRET}",
      quote: undefined,
      line: 4,
    };

    // When
    const warnings = warningsForEnvFileEntry(entry);

    // Then
    expect(warnings).toEqual([
      {
        line: 4,
        key: "TOKEN",
        message: "Value for TOKEN contains ${, which env files do not interpolate.",
        suggestion:
          "Use single quotes or $$ if you want a literal dollar, or set the value in environment: with {{ env.* }}.",
      },
    ]);
  });
});
