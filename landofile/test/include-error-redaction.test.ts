import { expect, test } from "bun:test";
import { includeError } from "../src/include-guard.ts";

test("include error fields remove URL credentials, query and fragment", () => {
  const url = "https://user:password-canary@example.test/source?token=query-canary#fragment-canary";
  const error = includeError({
    message: `Could not acquire ${url}`,
    source: url,
    kind: "fetch-failed",
    remediation: `Check ${url}`,
  });
  expect(error.source).toBe("https://example.test/source");
  expect(error.message).toBe("Could not acquire https://example.test/source");
  expect(error.remediation).toBe("Check https://example.test/source");
});
