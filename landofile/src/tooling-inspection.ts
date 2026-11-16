import { ToolingCompileError } from "@lando/sdk/errors";
import {
  type ValidationIssue,
  type ValidationIssuePath,
  type ValidationIssueSource,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { Result } from "effect";

export type ToolingInspection<A> = Result.Result<A, readonly [ValidationIssue, ...ValidationIssue[]]>;

export interface ToolingNormalizationSource {
  readonly path: string;
  /** Receives a full effective tooling path; return only a known physical source. */
  readonly locate?: (path: ValidationIssuePath) => ValidationIssueSource | undefined;
}

export const toolingCompileResult = <A>(
  name: string,
  inspection: ToolingInspection<A>,
  source?: ToolingNormalizationSource,
): Result.Result<A, ToolingCompileError> =>
  Result.mapError(inspection, (findings) => {
    const location = (relative: Pick<ValidationIssue, "path" | "source">) => {
      const path = ["tooling", name, ...relative.path];
      const physical = relative.source ?? source?.locate?.(path);
      return { path, ...(physical === undefined ? {} : { source: physical }) };
    };
    const issues = findings.map((issue) => ({
      ...issue,
      ...location(issue),
      ...(issue.related === undefined ? {} : { related: issue.related.map(location) }),
    }));
    const message = issues
      .map((issue) => `${formatValidationIssuePath(issue.path)}: ${issue.message}`)
      .join("; ");
    return new ToolingCompileError({
      tool: name,
      message,
      issues,
      omittedIssueCount: 0,
      ...(source === undefined ? {} : { source: { path: source.path, task: name } }),
      remediation: [
        ...new Set(issues.flatMap((issue) => (issue.suggestion === undefined ? [] : [issue.suggestion]))),
      ].join(" "),
    });
  });
