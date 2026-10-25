import { expect, test } from "bun:test";
import { buildBugReport, renderPlainBugReport } from "../../src/cli/bug-report.ts";

test("renders structured issues when the error tag has no special renderer", () => {
  // Given
  const error = {
    _tag: "CustomValidationError",
    message: "Invalid manifest.",
    issues: [{ path: ["contributes", "unsupported"], message: "Unexpected key" }],
  };

  // When
  const output = renderPlainBugReport(
    buildBugReport({ error, context: { commandId: "meta:plugin:link", cacheRoot: "/tmp/lando-cache" } }),
  );

  // Then
  expect(output).toContain("contributes.unsupported: Unexpected key");
});
