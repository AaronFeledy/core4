import { describe, expect, test } from "bun:test";

import { ConfigExpressionError } from "@lando/sdk/errors";

describe("ConfigExpressionError", () => {
  test("carries the expression path payload", () => {
    // Given
    const payload = {
      message: "Could not evaluate hostname expression.",
      expression: "{{ app.name }}.{{ proxy.defaultDomain }}",
      path: "services.appserver.routes.0.hostname",
      filePath: "/app/.lando.yml",
      remediation: "Fix the hostname expression, or set proxy.defaultDomain in global config.",
    };

    // When
    const error = new ConfigExpressionError(payload);

    // Then
    expect(error).toMatchObject({ _tag: "ConfigExpressionError", ...payload });
  });
});
