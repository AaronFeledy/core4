import { describe, expect, test } from "bun:test";

import { ConfigExpressionError } from "@lando/sdk/errors";
import type { ValidationIssuePath } from "@lando/sdk/schema";
import { Schema } from "effect";

describe("ConfigExpressionError", () => {
  test("carries the expression path payload", () => {
    // Given
    const payload = {
      message: "Could not evaluate hostname expression.",
      expression: "{{ app.name }}.{{ proxy.defaultDomain }}",
      path: ["services", "app.server", "routes", 0, "hostname"],
      filePath: "/app/.lando.yml",
      remediation: "Fix the hostname expression, or set proxy.defaultDomain in global config.",
    };

    // When
    const error = Schema.decodeUnknownSync(ConfigExpressionError)(
      Schema.encodeSync(ConfigExpressionError)(new ConfigExpressionError(payload)),
    );

    // Then
    expect(error).toMatchObject({ _tag: "ConfigExpressionError", ...payload });
  });

  test("requires structured paths in both the decoded and encoded public contract", () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const decoded: Equal<ConfigExpressionError["path"], ValidationIssuePath> = true;
    const encoded: Equal<(typeof ConfigExpressionError.Encoded)["path"], ValidationIssuePath> = true;
    expect([decoded, encoded]).toEqual([true, true]);
    expect(
      Schema.is(ConfigExpressionError)({
        _tag: "ConfigExpressionError",
        message: "invalid",
        expression: "{{ env.X }}",
        path: "services.web",
        filePath: "/app/.lando.yml",
        remediation: "Fix it.",
      }),
    ).toBe(false);
  });
});
