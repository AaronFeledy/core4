import { expect, test } from "bun:test";
import { buildBugReport } from "../../src/cli/bug-report.ts";

test("an unregistered issue rule drops only that rule, never the issue or its siblings", () => {
  const error = {
    _tag: "LandofileValidationError",
    message: "Invalid hostname.",
    remediation: "Fix the hostname.",
    issues: [
      {
        rule: "landofile.nope",
        path: ["hostnames", 0],
        message: "Invalid hostname.",
        suggestion: "Use a DNS name.",
      },
      { rule: "landofile.hostname", path: ["services", "web", "hostnames", 1], message: "Invalid hostname." },
    ],
  };

  const report = buildBugReport({
    error,
    context: { commandId: "app:config:lint", cacheRoot: "/tmp/lando-lint-rules-cache" },
  });

  expect(report).toMatchObject({ code: error._tag, body: error.message, remediation: error.remediation });
  expect(report.issues).toEqual([
    { path: ["hostnames", 0], message: "Invalid hostname.", suggestion: "Use a DNS name." },
    { rule: "landofile.hostname", path: ["services", "web", "hostnames", 1], message: "Invalid hostname." },
  ]);
});
