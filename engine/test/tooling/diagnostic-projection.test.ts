import { expect, test } from "bun:test";
import { ToolingCompileError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";
import { projectToolingDiagnostic } from "../../src/tooling/diagnostics.ts";

test("discloses at most eight findings and counts previously omitted findings", () => {
  const error = new ToolingCompileError({
    tool: "run",
    message: "Invalid inputs.",
    omittedIssueCount: 3,
    issues: Array.from({ length: 10 }, (_, i) => ({
      path: ["tooling", "run", "flags", i],
      message: "Invalid default.",
    })),
    cause: { password: "never-disclose" },
  });
  const result = projectToolingDiagnostic(error, createRedactor("secrets"));
  expect(result.issues.map((issue) => issue.path.at(-1))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(result.omittedIssueCount).toBe(5);
  expect(result).not.toHaveProperty("cause");
});

test("redacts all authored diagnostic strings including credential keys and related sources", () => {
  const secret = "private-canary";
  const error = new ToolingCompileError({
    tool: secret,
    message: `password=${secret}`,
    remediation: `Remove ${secret}`,
    source: { path: `/app/${secret}.yml`, task: secret },
    issues: [
      {
        path: ["tooling", secret, "flags", `password=${secret}`, 0],
        message: `Bearer ${secret}`,
        reason: secret,
        suggestion: `Remove ${secret}`,
        source: { layer: "canonical", file: `/${secret}.yml`, path: [secret] },
        related: [{ path: [secret], source: { layer: "env", variable: secret, path: [secret] } }],
      },
    ],
  });
  const result = projectToolingDiagnostic(error, createRedactor("secrets", { values: [secret] }));
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result).toMatchObject({
    tool: "[redacted]",
    source: { path: "/app/[redacted].yml", task: "[redacted]" },
    issues: [
      {
        path: ["tooling", "[redacted]", "flags", "password=[redacted]", 0],
        reason: "[redacted]",
        source: { file: "/[redacted].yml", path: ["[redacted]"] },
        related: [{ path: ["[redacted]"], source: { variable: "[redacted]", path: ["[redacted]"] } }],
      },
    ],
  });
});

test("measures after redaction so oversized secrets become retained complete locations", () => {
  const secret = "private-canary-".repeat(2000);
  const error = new ToolingCompileError({
    tool: "run",
    message: secret,
    remediation: `Remove ${secret}`,
    issues: [
      {
        path: ["tooling", "run", secret],
        message: "Invalid input.",
        related: [{ path: [secret], source: { layer: "script", file: `/${secret}.sh`, path: [secret] } }],
      },
    ],
  });
  const result = projectToolingDiagnostic(error, createRedactor("secrets", { values: [secret] }));
  expect(result.message).toBe("[redacted]");
  expect(result.issues).toEqual([
    {
      path: ["tooling", "run", "[redacted]"],
      message: "Invalid input.",
      related: [
        { path: ["[redacted]"], source: { layer: "script", file: "/[redacted].sh", path: ["[redacted]"] } },
      ],
    },
  ]);
  expect(result.omittedIssueCount).toBe(0);
});

test("omits oversized issues whole and fits aggregate UTF-8 JSON including escaped strings and overhead", () => {
  const long = "\u754c".repeat(1000);
  const error = new ToolingCompileError({
    tool: "run",
    message: long,
    remediation: long,
    issues: [
      { path: ["tooling", "run", "\u754c".repeat(6000)], message: "Oversized path." },
      ...Array.from({ length: 10 }, (_, i) => ({
        path: ["tooling", "run", i],
        message: long + '"'.repeat(500),
      })),
    ],
  });
  const result = projectToolingDiagnostic(error, createRedactor("secrets"));
  expect(result.issues.map((issue) => issue.path.at(-1))).toEqual([0, 1, 2]);
  expect(result.omittedIssueCount).toBe(8);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
  expect(Buffer.byteLength(result.message)).toBeLessThanOrEqual(1024);
  expect(Buffer.byteLength(result.remediation)).toBeLessThanOrEqual(1024);
  expect(result.message).not.toContain("\ufffd");
});

test("omits oversized source identities instead of fabricating shortened paths", () => {
  const error = new ToolingCompileError({
    tool: "x".repeat(2000),
    message: "Invalid input.",
    source: { path: `/${"x".repeat(17000)}`, task: "run" },
    issues: [{ path: ["flags", "x"], message: "Invalid alias." }],
  });
  const result = projectToolingDiagnostic(error, createRedactor("secrets"));
  expect(result.tool).toBe("[omitted]");
  expect(result).not.toHaveProperty("source");
  expect(result.issues).toHaveLength(1);
  expect(result.omittedIssueCount).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
});
