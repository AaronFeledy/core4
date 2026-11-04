import { expect, test } from "bun:test";
import { parseExpressionEither } from "@lando/sdk/expressions";
import { Result } from "effect";

test.each(["${NAME", "${#NAME}", "${NAME:=value}"])(
  "shell parameter errors explain escaping: %s",
  (source) => {
    const parsed = parseExpressionEither(source, { filePath: "config.yml" });
    expect(Result.isFailure(parsed)).toBe(true);
    if (Result.isFailure(parsed))
      expect(parsed.failure.remediation).toBe(
        "Lando reads ${...} as an expression. Write $${...} to keep the text as written.",
      );
  },
);

test.each(["{{ env.NAME", "${secret:}"])("other parser errors explain expression syntax: %s", (source) => {
  const parsed = parseExpressionEither(source, { filePath: "config.yml" });
  expect(Result.isFailure(parsed)).toBe(true);
  if (Result.isFailure(parsed))
    expect(parsed.failure.remediation).toBe("Fix the {{ }} expression, or write {{{{ to keep {{ as text.");
});
