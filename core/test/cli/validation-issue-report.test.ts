import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { encodeCommandResult } from "@lando/sdk/command-result";
import { LandofileValidationError, LandofileWriteValidationError } from "@lando/sdk/errors";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import { buildBugReport, renderPlainBugReport } from "../../src/cli/bug-report.ts";

const issue = {
  path: ["services", "web", "ports", 0],
  message: "Expected a port number from 1 through 65535.",
  suggestion: 'Did you mean "image"?',
} as const;

describe("validation issue rendering", () => {
  test("prints one line per issue as path, message, and suggestion", () => {
    const error = new LandofileValidationError({
      message: "Landofile contains unsupported keys.",
      file: "/tmp/app/.lando.yml",
      issues: [issue, { path: [], message: "The document root is not an object." }],
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
    const error = new LandofileValidationError({
      message: "Landofile contains unsupported keys.",
      file: "/tmp/app/.lando.yml",
      issues: [issue],
    });
    const line = Effect.runSync(
      encodeCommandResult({
        command: "app:config:lint",
        resultSchema: Schema.Struct({}),
        outcome: { _tag: "failure", error },
        redactor: createRedactor("secrets", { values: [] }),
      }),
    );
    const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.issues).toEqual([issue]);
  });
});
