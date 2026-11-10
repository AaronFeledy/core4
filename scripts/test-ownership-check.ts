import type { TestInventoryEntry, TestOwnershipIssue } from "./test-ownership.ts";
import { resolveTestSelection } from "./test-selection-files.ts";
import type { TestSelection } from "./test-selections.ts";
import { checkWorkflowBindings } from "./test-workflow-bindings.ts";

export const checkInventoryOwnership = async (input: {
  readonly entries: readonly TestInventoryEntry[];
  readonly unknown: readonly string[];
  readonly files: readonly string[];
  readonly selections: readonly TestSelection[];
  readonly manual: Readonly<Record<string, string>>;
  readonly workflowRoot: string;
}): Promise<readonly TestOwnershipIssue[]> => {
  const issues: TestOwnershipIssue[] = [];
  const unknown = new Set(input.unknown);
  for (const entry of input.entries) {
    if (unknown.has(entry.path))
      issues.push({
        code: "UNKNOWN_LOCATION",
        paths: [entry.path],
        remediation:
          "Move the test into a workspace test/ tree or scripts/, or register its workspace in package.json; see scripts/test-ownership.ts.",
      });
    else if (entry.owners.length === 0)
      issues.push({
        code: "UNOWNED",
        paths: [entry.path],
        remediation:
          "Needs live prerequisites: add to a selection in scripts/test-selections.ts and run it from its workflow generator. Needs none: rename to *.test.ts. Intentional gap: add MANUAL_TESTS with prerequisites in scripts/test-ownership.ts.",
      });
    if (entry.path in input.manual && entry.owners.some((owner) => owner !== "manual"))
      issues.push({
        code: "MANUAL_SELECTED",
        paths: [entry.path],
        remediation: "Remove the selected test from MANUAL_TESTS in scripts/test-ownership.ts.",
      });
  }
  const discovered = input.files.filter((path) => !unknown.has(path));
  for (const selection of input.selections) {
    for (const selector of selection.paths) {
      if (resolveTestSelection({ ...selection, paths: [selector] }, discovered).length === 0)
        issues.push({
          code: "STALE_SELECTOR",
          paths: [selection.id, selector],
          remediation: "Fix or remove the unmatched selector in scripts/test-selections.ts.",
        });
    }
  }
  for (const path of Object.keys(input.manual)) {
    if (!input.files.includes(path))
      issues.push({
        code: "MANUAL_STALE",
        paths: [path],
        remediation: "Remove the missing test from MANUAL_TESTS in scripts/test-ownership.ts.",
      });
  }
  issues.push(...(await checkWorkflowBindings(input.workflowRoot, input.selections)));
  return issues.sort(
    (a, b) => a.code.localeCompare(b.code) || a.paths.join("\0").localeCompare(b.paths.join("\0")),
  );
};
