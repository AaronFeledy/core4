import { describe, expect, test } from "bun:test";
import { Either } from "effect";

import { expressionTouchesOnlyScopes, parseExpressionEither } from "@lando/sdk/expressions";

const filePath = "/app/.lando.yml";
const allowed = ["app", "proxy"] as const;

const parse = (source: string) => {
  const parsed = parseExpressionEither(source, { filePath });
  if (Either.isLeft(parsed)) throw parsed.left;
  return parsed.right;
};

describe("expressionTouchesOnlyScopes", () => {
  test("allows app and proxy interpolations with literal concat", () => {
    // Given
    const template = parse("{{ app.name }}.{{ proxy.defaultDomain }}");

    // When / Then
    expect(expressionTouchesOnlyScopes(template, allowed)).toBe(true);
  });

  test("rejects an env scope", () => {
    // Given
    const template = parse("{{ env.HOME }}");

    // When / Then
    expect(expressionTouchesOnlyScopes(template, allowed)).toBe(false);
  });

  test("rejects load helpers", () => {
    // Given
    const template = parse("{{ load('./ca.pem') }}");

    // When / Then
    expect(expressionTouchesOnlyScopes(template, allowed)).toBe(false);
  });
});
