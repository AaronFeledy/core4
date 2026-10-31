import { expect, test } from "bun:test";
import { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { Schema } from "effect";
import { renderInitReview } from "../../src/cli/commands/init-review";
import { projectInitReviewRoutes } from "../../src/cli/commands/init-review-routes";
import { reviewWith } from "./init-review-fixtures";

test.each([80, 120])("wraps diagnostic prose to %i columns without losing its fields", (columns) => {
  // Given long diagnostic prose at the terminal width.
  const diagnostic = Schema.decodeUnknownSync(ConfigTranslateDiagnostic)({
    kind: "needs-review",
    sourceId: "fixture",
    keyPath: [],
    message: `DIAGNOSTIC_TOKEN ${"日本語 details ".repeat(30)}`.trim(),
    remediation: `REMEDIATION_TOKEN ${"review settings ".repeat(30)}`.trim(),
  });
  const review = { ...reviewWith(), diagnostics: [diagnostic] };

  // When the precommit review is formatted.
  const output = renderInitReview({
    review,
    routes: projectInitReviewRoutes(review, {}),
    decorated: false,
    columns,
    redact: (value) => value,
  });

  // Then wrapping preserves the supplied fields within the display-cell budget.
  const normalized = output.replace(/\s+/g, " ");
  expect(normalized).toContain(diagnostic.message);
  expect(normalized).toContain(diagnostic.remediation ?? "missing");
  const diagnosticRows = output.slice(output.indexOf("DIAGNOSTIC_TOKEN")).split("\n");
  expect(diagnosticRows.every((line) => Bun.stringWidth(line) <= columns)).toBe(true);
});
