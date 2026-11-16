type FailureIssue = {
  readonly title: string;
  readonly bodyScript?: string;
  readonly assignee?: string;
};

/**
 * A job stopped by `timeout-minutes` reaches its dependents as `cancelled`, not
 * `failure`, so a reporter treats both as failed. Pair it with `!cancelled()`
 * so a run cancelled as a whole files nothing.
 */
export const NEEDS_FAILED_OR_TIMED_OUT =
  "(contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled'))";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

export const renderFailureIssueStep = (issue: FailureIssue): string => {
  // Search, not the newest-100 window: the tracking issue may be older than 100 open issues.
  const search = `in:title ${JSON.stringify(issue.title)} sort:created-asc`;
  const query = `[.[] | select(.title == ${JSON.stringify(issue.title)})] | .[0].number // ""`;
  const assignee = issue.assignee === undefined ? "" : ` --assignee ${shellQuote(issue.assignee)}`;
  return `      - name: Report automation failure
        run: |
          set -euo pipefail
          TITLE=${shellQuote(issue.title)}
${(issue.bodyScript ?? 'BODY="Workflow run failed: $RUN_URL"')
  .split("\n")
  .map((line) => `          ${line}`)
  .join("\n")}
          ISSUE_NUMBER="$(gh issue list --state open --search ${shellQuote(search)} --limit 100 --json number,title --jq ${shellQuote(query)})"
          if [ -n "$ISSUE_NUMBER" ]; then
            gh issue comment "$ISSUE_NUMBER" --body "$BODY"
          else
            gh issue create --title "$TITLE" --body "$BODY"${assignee}
          fi`;
};
