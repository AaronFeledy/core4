import { type ValidationFix, formatValidationIssuePath } from "@lando/sdk/schema";
import { emitYamlDocument, quoteYamlScalar } from "@lando/sdk/yaml";
import { escapeDiagnosticText } from "./diagnostic-text.ts";

export const formatValidationFixEdits = (fix: ValidationFix): readonly string[] =>
  fix.edits.flatMap((edit) => {
    const path = escapeDiagnosticText(formatValidationIssuePath(edit.path));
    if (typeof edit.value === "object" && edit.value !== null) {
      return [
        `${path}:`,
        ...emitYamlDocument(edit.value)
          .trimEnd()
          .split("\n")
          .map((line) => `  ${escapeDiagnosticText(line)}`),
      ];
    }
    const value = typeof edit.value === "string" ? quoteYamlScalar(edit.value) : String(edit.value);
    return [`${path}: ${escapeDiagnosticText(value)}`];
  });
