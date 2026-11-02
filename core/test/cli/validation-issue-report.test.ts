import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { encodeCommandResult } from "@lando/sdk/command-result";
import { ConfigError, LandofileValidationError, LandofileWriteValidationError } from "@lando/sdk/errors";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { buildBugReport, renderPlainBugReport } from "../../src/cli/bug-report.ts";
import { formatStructuredIssue } from "../../src/cli/validation-issue-text.ts";

const issue = {
  path: ["services", "web", "ports", 0],
  message: "Expected a port number from 1 through 65535.",
  suggestion: 'Did you mean "image"?',
} as const;

describe("validation issue rendering", () => {
  test("appends readable ordered edits and keeps block YAML in the load-failure report", () => {
    const error = new LandofileValidationError({
      file: "/tmp/app/.lando.yml",
      message: "Invalid secret site.",
      remediation: "Apply the fix.",
      issues: [
        {
          ...issue,
          fix: {
            edits: [
              { op: "set", path: ["tooling", "deploy", "env", "TOKEN"], value: "${secret:TOKEN}" },
              {
                op: "set",
                path: ["events", "post-start", 0],
                value: { cmd: "echo $TOKEN", env: { TOKEN: "${secret:TOKEN}" } },
              },
            ],
          },
        },
      ],
    });
    const text = renderPlainBugReport(buildBugReport({ error, context: { commandId: "app:start" } }));
    expect(text).toContain(
      [
        '       | tooling.deploy.env.TOKEN: "${secret:TOKEN}"',
        "       | events.post-start[0]:",
        '       |   cmd: "echo $TOKEN"',
        "       |   env:",
        '       |     TOKEN: "${secret:TOKEN}"',
      ].join("\n"),
    );
  });

  test("escapes edit controls in structured issue text", () => {
    const text = formatStructuredIssue({
      ...issue,
      fix: { edits: [{ op: "set", path: ["bad\n\u001b"], value: { cmd: "echo\u009b" } }] },
    });
    expect(text?.split("\n").slice(1)).toEqual([
      "       | bad\\u000a\\u001b:",
      '       |   cmd: "echo\\u009b"',
    ]);
  });
  test("prints config field issues and repair guidance in plain output", () => {
    const error = new ConfigError({
      message: "Invalid global configuration.",
      path: "/tmp/config.yml",
      issues: [{ path: ["router", "httpPort"], message: "Expected a valid port." }],
      remediation: "Run `lando config validate` or `lando config edit`.",
    });
    const text = renderPlainBugReport(buildBugReport({ error, context: { commandId: "app:info" } }));
    expect(text).toContain("router.httpPort: Expected a valid port.");
    expect(text).toContain("lando config validate");
    expect(text).toContain("lando config edit");
  });
  test("prints one line per issue as path, message, and suggestion", () => {
    const error = new LandofileValidationError({
      message: "Landofile contains unsupported keys.",
      file: "/tmp/app/.lando.yml",
      issues: [issue, { path: [], message: "The document root is not an object." }],
      remediation: "Fix the reported issue(s).",
    });
    const text = renderPlainBugReport(buildBugReport({ error, context: { commandId: "app:config:lint" } }));
    expect(text).toContain(
      'services.web.ports[0]: Expected a port number from 1 through 65535. Did you mean "image"?',
    );
    expect(text).toContain("The document root is not an object.");
    expect(text).not.toContain(": The document root");
  });

  test("prints write-validation issues hidden behind a summary message", () => {
    const error = new LandofileWriteValidationError({
      message: "The resulting config failed validation for /tmp/app/.lando.yml.",
      file: "/tmp/app/.lando.yml",
      issues: [issue],
      remediation: "Fix the reported issue(s), then retry the write. The file was left unchanged.",
    });
    const text = renderPlainBugReport(buildBugReport({ error, context: { commandId: "app:config:set" } }));
    expect(text).toContain("services.web.ports[0]: Expected a port number from 1 through 65535.");
  });

  test("json command envelope carries structured issues", () => {
    const sourcedIssue = {
      ...issue,
      fix: {
        edits: [{ op: "set", path: ["tooling", "deploy", "cmd"], value: "echo $TOKEN" }] as const,
      },
      source: { file: "/tmp/app/.lando.local.yml", layer: "local" as const, path: issue.path },
    };
    const error = new LandofileValidationError({
      message: "Landofile contains unsupported keys.",
      file: "/tmp/app/.lando.yml",
      issues: [sourcedIssue],
      remediation: "Fix the reported issue(s).",
    });
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:config:lint",
        resultSchema: Schema.Struct({}),
        outcome: { _tag: "failure", error, additionalErrors: [] },
        redactor: createRedactor("secrets", { values: [] }),
      }),
    );
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.issues).toEqual([sourcedIssue]);
    expect(envelope.error?.remediation).toBe(error.remediation);
  });
});
