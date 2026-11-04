import { Schema, type SchemaIssue } from "effect";

export const InputIssue = Schema.Struct({
  path: Schema.Literals(["input", "root", "workflow"]),
  rule: Schema.Literals(["required", "type", "path", "unknown-field"]),
});
export type InputIssue = typeof InputIssue.Type;

const message = "GitHub Actions inspection could not start.";
const remedies = {
  "invalid-options":
    "Supply --root and optionally --workflow .github/workflows/<filename>.yml (or .yaml); no other inspection options are accepted.",
  "invalid-root": "Choose an existing readable repository directory with --root.",
  "root-required":
    "Supply an explicit repository directory as root; the CLI defaults --root to its invocation directory.",
  "invalid-workflow":
    "Supply --workflow as one exact .github/workflows/<filename>.yml or .yaml path without traversal or control characters.",
  "unknown-input": "Remove unsupported inspection options; only root and workflow are accepted.",
  "unsafe-directory": "Use real .github and workflows directories, not symlinks or nondirectory entries.",
  "unreadable-directory": "Allow directory listing access to .github/workflows, then retry.",
  "workflow-not-found":
    "Choose an existing direct .github/workflows/<filename>.yml (or .yaml) file with --workflow.",
  "inventory-limit":
    "Reduce the workflow directory to at most 100 workflow files and 1000 entries, or select one file with --workflow.",
} as const;
export class GithubActionsWorkflowError extends Schema.TaggedError<GithubActionsWorkflowError>()(
  "GithubActionsWorkflowError",
  {
    message: Schema.Literal(message),
    reason: Schema.Literals([
      "invalid-options",
      "invalid-root",
      "root-required",
      "invalid-workflow",
      "unknown-input",
      "unsafe-directory",
      "unreadable-directory",
      "workflow-not-found",
      "inventory-limit",
    ]),
    remediation: Schema.String,
    issue: Schema.optionalKey(InputIssue),
  },
) {}
export const workflowError = (reason: keyof typeof remedies) =>
  new GithubActionsWorkflowError({ message, reason, remediation: remedies[reason] });

export const inputIssueError = (
  issue: SchemaIssue.Issue,
  path: InputIssue["path"] = "input",
): GithubActionsWorkflowError => {
  switch (issue._tag) {
    case "Pointer": {
      const key = issue.path[0];
      return inputIssueError(issue.issue, key === "root" || key === "workflow" ? key : "input");
    }
    case "Composite":
      return inputIssueError(issue.issues[0], path);
    case "Filter":
    case "Encoding":
      return inputIssueError(issue.issue, path);
    case "UnexpectedKey":
      return new GithubActionsWorkflowError({
        message,
        reason: "unknown-input",
        remediation: remedies["unknown-input"],
        issue: { path: "input", rule: "unknown-field" },
      });
    case "MissingKey":
      return new GithubActionsWorkflowError({
        message,
        reason: "root-required",
        remediation: remedies["root-required"],
        issue: { path: "root", rule: "required" },
      });
    case "InvalidType":
    case "InvalidValue":
    case "Forbidden":
    case "AnyOf":
    case "OneOf": {
      const reason =
        path === "root" ? "invalid-root" : path === "workflow" ? "invalid-workflow" : "invalid-options";
      const rule = issue._tag === "InvalidValue" ? "path" : "type";
      return new GithubActionsWorkflowError({
        message,
        reason,
        issue: { path, rule },
        remediation:
          path === "root"
            ? "Supply root as a nonempty directory path string without control characters."
            : remedies[reason],
      });
    }
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
};
