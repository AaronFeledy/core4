import {
  NEEDS_UNSUCCESSFUL,
  UNSUCCESSFUL_NEEDS_RESULTS,
  renderFailureIssueStep,
} from "./_failure-issue-workflow.ts";

export const renderNightlyFailureJob = (jobsYaml: string): string => {
  const needs = [...jobsYaml.matchAll(/^ {2}([\w-]+):$/gm)].map((match) => match[1]);
  return `
  report-failure:
    needs: [${needs.join(", ")}]
    if: \${{ !cancelled() && github.event_name == 'schedule' && github.ref == 'refs/heads/main' && ${NEEDS_UNSUCCESSFUL} }}
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
  bodyScript: `FAILED_JOBS="$(jq -r '[to_entries[] | select(.value.result | IN(${UNSUCCESSFUL_NEEDS_RESULTS.map((result) => JSON.stringify(result)).join(", ")})) | .key + (if .value.result == "cancelled" then " (timed out or cancelled)" elif .value.result == "abandoned" then " (abandoned)" else "" end)] | join(", ")' <<< "$NEEDS_JSON")"
printf -v BODY 'Workflow run failed: %s\\n\\nFailed jobs: %s' "$RUN_URL" "$FAILED_JOBS"`,
})}`;
};
