import { expect, test } from "bun:test";
import { buildBugReport, renderJsonBugReport, renderPlainBugReport } from "../../src/cli/bug-report.ts";

test("renders structured issues when the error tag has no special renderer", () => {
  // Given
  const error = {
    _tag: "CustomValidationError",
    message: "Invalid manifest.",
    remediation: "Remove contributes.unsupported.",
    issues: [{ path: ["contributes", "unsupported"], message: "Unexpected key" }],
  };

  // When
  const report = buildBugReport({
    error,
    context: { commandId: "meta:plugin:link", cacheRoot: "/tmp/lando-cache" },
  });
  const output = renderPlainBugReport(report);

  // Then
  expect(output).toContain("contributes.unsupported: Unexpected key");
  expect(JSON.parse(renderJsonBugReport(report)).issues).toEqual(error.issues);
});
