import { NEEDS_FAILED_OR_TIMED_OUT, renderFailureIssueStep } from "./_failure-issue-workflow.ts";

export const renderNightlyFailureJob = (jobsYaml: string): string => {
  const needs = [...jobsYaml.matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]);
  return `
  report-failure:
    needs: [${needs.join(", ")}]
    if: \${{ !cancelled() && github.event_name == 'schedule' && github.ref == 'refs/heads/main' && ${NEEDS_FAILED_OR_TIMED_OUT} }}
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      issues: write
    env:
      GH_TOKEN: \${{ github.token }}
      GH_REPO: \${{ github.repository }}
      RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
      NEEDS_JSON: \${{ toJSON(needs) }}
    steps:
${renderFailureIssueStep({
  title: "nightly automation failure",
  assignee: "AaronFeledy",
  // A job stopped by timeout-minutes reaches needs as cancelled; in a run nobody cancelled, report it too.
  bodyScript: `FAILED_JOBS="$(jq -r '[to_entries[] | select(.value.result == "failure" or .value.result == "cancelled") | .key + (if .value.result == "cancelled" then " (timed out or cancelled)" else "" end)] | join(", ")' <<< "$NEEDS_JSON")"
printf -v BODY 'Workflow run failed: %s\\n\\nFailed jobs: %s' "$RUN_URL" "$FAILED_JOBS"`,
})}`;
};
