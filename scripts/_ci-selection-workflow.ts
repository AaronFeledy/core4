import { LINUX_X64_TEST_RUNNER } from "./ci-platforms.ts";
import { CI_JOB_TIERS, jobCondition } from "./ci-selection.ts";

const setup = `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version
      - run: bun install --frozen-lockfile`;

export const ciResultSteps = `    steps:
${setup}
      - name: Validate selected job results
        env:
          CI_PROFILE: \${{ needs.selection.outputs.profile }}
          CI_BROAD: \${{ needs.selection.outputs.broad }}
          CI_NEEDS: \${{ toJSON(needs) }}
        run: bun run scripts/validate-ci.ts
`;

export const applyCiSelection = (workflow: string): string => {
  const start = workflow.indexOf("jobs:\n") + "jobs:\n".length;
  const jobs = workflow.slice(start).split(/(?=^ {2}[a-z][a-z0-9-]*:\n)/m);
  const selected = jobs
    .map((block) => {
      const id = /^ {2}([a-z][a-z0-9-]*):\n/.exec(block)?.[1];
      if (!id || id === "deploy-docs") return block;
      const tier = CI_JOB_TIERS[id];
      if (!tier) throw new TypeError(`CI job has no selection tier: ${id}`);
      const needsLine = /^ {4}needs: (.+)\n/m.exec(block)?.[1];
      const needs = needsLine
        ? needsLine
            .replace(/[\[\]]/g, "")
            .split(",")
            .map((value) => value.trim())
        : [];
      const isSummary = /^ {4}if: always\(\)$/m.test(block);
      const body = block.replace(/^ {4}needs: .+\n/m, "").replace(/^ {4}if: .+\n/m, "");
      return body.replace(
        `  ${id}:\n`,
        `  ${id}:\n    needs: [selection${needs.map((need) => `, ${need}`).join("")}]\n    if: \${{ always() && !cancelled()${isSummary ? "" : " && !failure()"} && needs.selection.result == 'success' && (${jobCondition(tier)}) }}\n`,
      );
    })
    .join("");
  return `${workflow.slice(0, start)}
  selection:
    runs-on: ${LINUX_X64_TEST_RUNNER}
    timeout-minutes: 5
    outputs:
      profile: \${{ steps.select.outputs.profile }}
      broad: \${{ steps.select.outputs.broad }}
      reason: \${{ steps.select.outputs.reason }}
    steps:
${setup}
      - name: Select CI profile
        id: select
        env:
          CI_BASE_SHA: \${{ github.event.pull_request.base.sha }}
          CI_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: bun run scripts/select-ci.ts
${selected}
  ci:
    needs: [selection, ${Object.keys(CI_JOB_TIERS)
      .filter((id) => id !== "bun-install-isolated-experiment")
      .join(", ")}]
    if: always()
    runs-on: ${LINUX_X64_TEST_RUNNER}
    timeout-minutes: 5
${ciResultSteps}`;
};
