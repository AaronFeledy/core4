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

test("renders failure members once with paths, locations, issues and individual remediation", () => {
  // Given a field-generic aggregate, not a special Landofile error tag.
  const error = {
    _tag: "CustomAggregateError",
    message: "Loading failed with 2 problems.",
    remediation: "Fix both problems.",
    failures: [
      {
        _tag: "IncludeError",
        path: ["includes", 0],
        filePath: "/app/.lando.yml",
        sourceFile: "/app/loader.yml",
        layer: "canonical",
        line: 3,
        column: 5,
        message: "Missing fragment.",
        remediation: "Correct the first path.",
      },
      {
        _tag: "ValidationError",
        path: ["includes", 1],
        source: { file: "/app/.lando.local.yml", layer: "local", path: ["includes", 1] },
        message: "Invalid fragment.\u001b[2J",
        issues: [{ path: ["services", "web", "ports", 0], message: "Invalid port" }],
        remediation: "Replace private-token safely.",
      },
    ],
  };
  // When projected and rendered through the real bug-report surface.
  const report = buildBugReport({
    error,
    context: { commandId: "app:start", cacheRoot: "/tmp/lando-cache" },
    sourceEnv: { SECRET_TOKEN: "private-token" },
  });
  const output = renderPlainBugReport(report);
  // Then each member is actionable without duplicating the list or becoming a Cause peer.
  expect(output).toContain("includes[0]: Missing fragment.");
  expect(output).toContain("at /app/.lando.yml:3:5 (canonical layer)");
  expect(output).toContain("at /app/.lando.local.yml (local layer)");
  expect(output).toContain("services.web.ports[0]: Invalid port");
  expect(output).toContain("↳ Correct the first path.");
  expect(output).toContain("↳ Replace [redacted] safely.");
  expect(output).not.toContain("private-token");
  expect(output.match(/Missing fragment\./gu)).toHaveLength(1);
  expect(output.match(/Fix both problems\./gu)).toHaveLength(1);
  expect(output.indexOf("↳ Correct the first path.")).toBeLessThan(output.indexOf("↳ Fix both problems."));
  expect(output).not.toContain("\u001b");
  expect(report.additionalErrors).toBeUndefined();
  // The JSON diagnostic record keeps the members structured, redacted, and out of the flattened fields.
  const json = JSON.parse(renderJsonBugReport(report));
  expect(json.failures).toMatchObject([
    { _tag: "IncludeError", path: ["includes", 0], remediation: "Correct the first path." },
    { _tag: "ValidationError", path: ["includes", 1], remediation: "Replace [redacted] safely." },
  ]);
  expect(JSON.stringify(json)).not.toContain("private-token");
});

test("formats standalone structured path fields with bracket indexes", () => {
  const report = buildBugReport({
    error: {
      _tag: "ExpressionError",
      message: "Missing value.",
      remediation: "Set it.",
      path: ["includes", 2, "when"],
    },
    context: { commandId: "app:start", cacheRoot: "/tmp/lando-cache" },
  });
  expect(renderPlainBugReport(report)).toContain("path: includes[2].when");
});
