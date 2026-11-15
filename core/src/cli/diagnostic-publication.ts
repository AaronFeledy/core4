import type { CommandLoadError } from "@lando/engine/cache/command-index";
import { boundedDiagnosticSummary, projectToolingDiagnostic } from "@lando/sdk/command-result";
import type { Redactor } from "@lando/sdk/secrets";
import { isToolingDiagnostic } from "./tooling-unavailable";

export const publishDiagnosticSummary = <
  A extends {
    readonly message: string;
    readonly remediation?: string;
  },
>(
  diagnostic: A,
  redactor: Pick<Redactor, "redactString">,
): A => ({
  ...diagnostic,
  message: boundedDiagnosticSummary(redactor.redactString(diagnostic.message), redactor),
  ...(diagnostic.remediation === undefined
    ? {}
    : { remediation: boundedDiagnosticSummary(redactor.redactString(diagnostic.remediation), redactor) }),
});

export const publishCommandDiagnostic = (
  diagnostic: CommandLoadError,
  redactor: Pick<Redactor, "redactString">,
): CommandLoadError =>
  isToolingDiagnostic(diagnostic)
    ? projectToolingDiagnostic(diagnostic, redactor)
    : publishDiagnosticSummary(diagnostic, redactor);
