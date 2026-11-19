type FailureIssue = {
  readonly title: string;
  readonly assignee?: string;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

/**
 * Run the reporter after every eligible non-cancelled run: GitHub can return
 * undocumented job results such as `abandoned`, so this step decides from
 * `needs` rather than an `if:` list. `!cancelled()` keeps whole-run cancellations
 * from filing anything.
 */
export const renderFailureIssueStep = (issue: FailureIssue): string => {
  // Search, not the newest-100 window: the tracking issue may be older than 100 open issues.
  const search = `in:title ${JSON.stringify(issue.title)} sort:created-asc`;
  const query = `[.[] | select(.title == ${JSON.stringify(issue.title)})] | .[0].number // ""`;
  const assignee = issue.assignee === undefined ? "" : ` --assignee ${shellQuote(issue.assignee)}`;
  return `      - name: Report automation failure
        run: |
          set -euo pipefail
          FAILED_JOBS="$(jq -r '
            [to_entries[] | .value.result as $result
              | select($result != "success" and $result != "skipped")
              | .key + (if $result == "failure" then ""
                        elif $result == "cancelled" then " (timed out or cancelled)"
                        else " (\\($result))" end)] | join(", ")
          ' <<< "$NEEDS_JSON")"
          if [ -z "$FAILED_JOBS" ]; then
            echo "No unsuccessful jobs."
            exit 0
          fi
          TITLE=${shellQuote(issue.title)}
          printf -v BODY 'Workflow run failed: %s\\n\\nFailed jobs: %s' "$RUN_URL" "$FAILED_JOBS"
          ISSUE_NUMBER="$(gh issue list --state open --search ${shellQuote(search)} --limit 100 --json number,title --jq ${shellQuote(query)})"
          if [ -n "$ISSUE_NUMBER" ]; then
            gh issue comment "$ISSUE_NUMBER" --body "$BODY"
          else
            gh issue create --title "$TITLE" --body "$BODY"${assignee}
          fi`;
};
