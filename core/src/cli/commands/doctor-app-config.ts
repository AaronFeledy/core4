import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import {
  type ConfigLintResult,
  type ConfigLintViolation,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import type { DoctorFinding } from "./doctor-contract";

export const appConfigForReport = () =>
  appConfigLint().pipe(
    Effect.catchTag("LandofileNotFoundError", (error) =>
      Effect.succeed({
        app: "",
        file: "(none)",
        valid: false,
        violations: [
          {
            rule: "landofile.discovery",
            severity: "error",
            path: [],
            scopes: ["fragment"],
            message: error.message,
          },
        ],
      } satisfies ConfigLintResult),
    ),
    Effect.catchTag("LandofileFormConflictError", (error) =>
      Effect.succeed({
        app: "",
        file: error.yamlPath,
        valid: false,
        violations: [
          {
            rule: "landofile.discovery",
            severity: "error",
            path: [],
            scopes: ["fragment"],
            message: error.message,
          },
        ],
      } satisfies ConfigLintResult),
    ),
  );

const violationLocation = (violation: ConfigLintViolation): string => {
  const formatted = formatValidationIssuePath(violation.path);
  return formatted.length === 0 ? "(root)" : formatted;
};

export const appConfigFindings = (result: ConfigLintResult): ReadonlyArray<DoctorFinding> => {
  if (result.violations.length === 0)
    return [
      {
        name: "app-config-lint",
        status: "pass",
        severity: "info",
        context: { file: result.file },
        solutions: [],
      },
    ];
  return result.violations.map((violation) => ({
    name: violation.rule,
    status: violation.severity === "error" ? "fail" : "warn",
    severity: violation.severity === "error" ? "error" : "warn",
    context: {
      file: result.file,
      location: violationLocation(violation),
      message: violation.message,
      ...(violation.reason === undefined ? {} : { reason: violation.reason }),
      ...(violation.line === undefined ? {} : { line: String(violation.line) }),
      ...(violation.column === undefined ? {} : { column: String(violation.column) }),
      ...(violation.source === undefined ? {} : { source: violation.source.layer }),
    },
    solutions:
      violation.suggestion === undefined ? [] : [{ kind: "manual", description: violation.suggestion }],
    details: violation,
  }));
};
