import { expect, test } from "bun:test";

import { renderConfigLintViolation } from "../../src/cli/commands/config-lint-rendering.ts";

test("config lint text visibly escapes terminal controls", () => {
  const rendered = renderConfigLintViolation({
    path: "services.web\u001b[31m",
    message: "Rejected key\u0007",
    suggestedFix: "Remove it\u009b",
  });

  expect(rendered).not.toContain("\u001b");
  expect(rendered).not.toContain("\u0007");
  expect(rendered).not.toContain("\u009b");
  expect(rendered).toContain("\\u001b");
  expect(rendered).toContain("\\u0007");
  expect(rendered).toContain("\\u009b");
});
