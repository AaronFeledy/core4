type FailureIssue = {
  readonly title: string;
  readonly assignee?: string;
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

// Bounds keep the largest report well under GitHub's 65,536-character comment limit, and the
// worst-case download time well inside the reporter job's timeout.
const EVIDENCE_JOBS = 5;
const EVIDENCE_ATTEMPTS = 8;
const EVIDENCE_REQUEST_SECONDS = 20;
const EVIDENCE_LINES = 30;
const EVIDENCE_LINE_CHARS = 240;

/** The permissions and env a reporter job needs for {@link renderFailureIssueStep}. */
export const renderFailureIssueAccess = (): string => `    permissions:
      actions: read
      issues: write
    env:
      GH_TOKEN: \${{ github.token }}
      GH_REPO: \${{ github.repository }}
      RUN_ID: \${{ github.run_id }}
      RUN_ATTEMPT: \${{ github.run_attempt }}
      RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
      NEEDS_JSON: \${{ toJSON(needs) }}`;

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
  // Finished jobs that did not succeed, with the step that failed or was cut off.
  const failedJobs = `.jobs[] | select(.conclusion != null and .conclusion != "success" and .conclusion != "skipped") | [.id, .name, ([.steps[]? | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | .name][0] // "")] | @tsv`;
  // The log lines leading up to the first failed run step's exit (else the last error, else the end),
  // without the BOM, timestamps, carriage returns, colors, group markers, or blank lines.
  const logTail = [
    '{ sub(/\\r$/, "")',
    'sub(/^(\\357\\273\\277)?[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9:.]+Z ?/, "")',
    'gsub(/\\033\\[[0-9;]*[A-Za-z]/, "")',
    "if ($0 ~ /^##\\[endgroup\\]$/ || $0 ~ /^[[:space:]]*$/) next",
    'sub(/^##\\[group\\]/, "")',
    `line[++count] = substr($0, 1, ${EVIDENCE_LINE_CHARS})`,
    "if (!exited && $0 ~ /^##\\[error\\]Process completed with exit code/) exited = count",
    "if ($0 ~ /^##\\[error\\]/) last = count }",
    `END { end = exited ? exited : (last ? last : count); for (i = (end > ${EVIDENCE_LINES} ? end - ${EVIDENCE_LINES - 1} : 1); i <= end; i++) print line[i] }`,
  ].join("; ");
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
          SUMMARY_FILE="$RUNNER_TEMP/failure-summary.md"
          BODY_FILE="$RUNNER_TEMP/failure-issue.md"
          printf 'Workflow run failed: %s\\n\\nFailed jobs: %s\\n' "$RUN_URL" "$FAILED_JOBS" > "$SUMMARY_FILE"
          cp "$SUMMARY_FILE" "$BODY_FILE"
          # Log evidence is best effort: the issue is filed even when job details or logs are unreadable.
          # Log text is untrusted, so it only moves through files and is fenced in the body.
          JOBS_FILE="$RUNNER_TEMP/failed-jobs.tsv"
          if timeout ${EVIDENCE_REQUEST_SECONDS} gh api "repos/$GH_REPO/actions/runs/$RUN_ID/attempts/$RUN_ATTEMPT/jobs" --paginate --jq ${shellQuote(failedJobs)} > "$JOBS_FILE"; then
            SHOWN=0
            ATTEMPTS=0
            while IFS=$'\\t' read -r -u 3 JOB_ID JOB_NAME STEP_NAME; do
              if [ "$SHOWN" -eq ${EVIDENCE_JOBS} ] || [ "$ATTEMPTS" -eq ${EVIDENCE_ATTEMPTS} ]; then
                printf '\\nLogs for the remaining failed jobs are in the run.\\n' >> "$BODY_FILE"
                break
              fi
              ATTEMPTS=$((ATTEMPTS + 1))
              LOG_FILE="$RUNNER_TEMP/job-$JOB_ID.log"
              TAIL_FILE="$RUNNER_TEMP/job-$JOB_ID.tail"
              timeout ${EVIDENCE_REQUEST_SECONDS} gh api "repos/$GH_REPO/actions/jobs/$JOB_ID/logs" > "$LOG_FILE" || continue
              awk ${shellQuote(logTail)} "$LOG_FILE" > "$TAIL_FILE" || continue
              FENCE='\`\`\`'
              while grep -qF -- "$FENCE" "$TAIL_FILE"; do FENCE="$FENCE\\\`"; done
              {
                printf '\\n### %s' "$JOB_NAME"
                if [ -n "$STEP_NAME" ]; then printf ': %s' "$STEP_NAME"; fi
                printf '\\n\\n%s\\n' "$FENCE"
                cat "$TAIL_FILE"
                printf '%s\\n' "$FENCE"
              } >> "$BODY_FILE"
              SHOWN=$((SHOWN + 1))
            done 3< "$JOBS_FILE"
          fi
          TITLE=${shellQuote(issue.title)}
          ISSUE_NUMBER="$(gh issue list --state open --search ${shellQuote(search)} --limit 100 --json number,title --jq ${shellQuote(query)})"
          post() {
            if [ -n "$ISSUE_NUMBER" ]; then
              gh issue comment "$ISSUE_NUMBER" --body-file "$1"
            else
              gh issue create --title "$TITLE" --body-file "$1"${assignee}
            fi
          }
          # Quoted log bytes can make GitHub reject the body; the summary alone must still land.
          post "$BODY_FILE" || post "$SUMMARY_FILE"`;
};
