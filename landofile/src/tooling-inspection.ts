import { ToolingCompileError } from "@lando/sdk/errors";
import { type ValidationIssue, formatValidationIssueLine } from "@lando/sdk/schema";
import { Result } from "effect";

export type ToolingInspection<A> = Result.Result<A, readonly [ValidationIssue, ...ValidationIssue[]]>;

export const toolingCompileResult = <A>(
  name: string,
  inspection: ToolingInspection<A>,
  source?: { readonly path: string },
): Result.Result<A, ToolingCompileError> =>
  Result.mapError(inspection, (issues) => {
    const message = issues
      .map((issue) => formatValidationIssueLine({ ...issue, path: ["tooling", name, ...issue.path] }))
      .join("; ");
    return new ToolingCompileError({
      tool: name,
      message,
      ...(source === undefined ? {} : { source: { path: source.path, task: name } }),
      remediation: `Correct the tooling declaration for ${name}: ${message}`,
    });
  });
