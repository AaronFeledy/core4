import {
  GuideFrontmatterValidationError,
  GuideHiddenScenarioReasonError,
  NotImplementedError,
} from "@lando/core/errors";
import { GuidePropError, GuideRootError, GuideSemanticError } from "./diagnostic.ts";
import { type MdxNode, lineOf } from "./mdx.ts";

export interface GuideLintDiagnostic {
  readonly sourcePath: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
  readonly scenario?: string;
  readonly variant?: string;
  readonly component?: string;
  readonly prop?: string;
  readonly name?: string;
  readonly relatedDeclarationLine?: number;
  readonly remediation?: string;
}
export const diagnostic = (
  sourcePath: string,
  node: MdxNode,
  code: string,
  message: string,
): GuideLintDiagnostic => ({
  sourcePath,
  line: lineOf(node),
  column: node.position?.start?.column ?? 1,
  code,
  message,
});
export const formatErrorMessage = (error: unknown): string => {
  if (
    error instanceof NotImplementedError ||
    error instanceof GuideFrontmatterValidationError ||
    error instanceof GuideHiddenScenarioReasonError
  )
    return `${error.message} ${error.remediation}`;
  return error instanceof Error ? error.message : String(error);
};
export const errorDiagnostic = (sourcePath: string, error: unknown): GuideLintDiagnostic => {
  if (error instanceof GuidePropError)
    return {
      ...error,
      line: error.line,
      column: error.column,
      message: `${error.message} ${error.remediation}`,
    };
  if (error instanceof GuideSemanticError || error instanceof GuideRootError)
    return { ...error, line: error.line, column: 1, message: `${error.message} ${error.remediation}` };
  return {
    sourcePath,
    line: 1,
    column: 1,
    code: "guide.transcript.parse",
    message: `Could not parse guide scenarios: ${formatErrorMessage(error)}`,
  };
};
