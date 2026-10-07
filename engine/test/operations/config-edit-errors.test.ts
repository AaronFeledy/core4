import { describe, expect, test } from "bun:test";

import { validationIssue } from "@lando/sdk/schema";
import { editorFailedError, noEditorError } from "../../src/config-write/verbs.ts";

describe("config editor errors", () => {
  test("reports missing editor configuration with the original remediation", () => {
    // Given
    const file = "/tmp/config.yml";
    // When
    const error = noEditorError(file);
    // Then
    expect(error._tag).toBe("LandofileWriteValidationError");
    expect({
      message: error.message,
      file: error.file,
      issues: error.issues,
      remediation: error.remediation,
    }).toEqual({
      message: "No editor is configured.",
      file,
      issues: [validationIssue([], "Neither $VISUAL nor $EDITOR is set.")],
      remediation: "Set `$VISUAL` or `$EDITOR`, or pass `--editor <bin>`.",
    });
  });

  test("preserves the caller's remediation when the editor fails", () => {
    // Given
    const file = "/tmp/.lando.yml";
    const reason = "editor exited with status 2";
    const remediation =
      "Re-run `lando config edit` after resolving the editor error. The file was left unchanged.";
    // When
    const error = editorFailedError(file, reason, remediation);
    // Then
    expect(error._tag).toBe("LandofileWriteValidationError");
    expect({
      message: error.message,
      file: error.file,
      issues: error.issues,
      remediation: error.remediation,
    }).toEqual({
      message: "The editor session failed: editor exited with status 2",
      file,
      issues: [validationIssue([], reason)],
      remediation,
    });
  });
});
