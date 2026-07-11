import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ClosureFindingReport,
  ClosureFindingResolution,
  ClosureReviewReport,
} from "./closure-review-report.ts";

export interface WriteClosureReviewOutputsInput {
  readonly report: ClosureReviewReport;
  readonly reportPath: string;
  readonly notePath: string;
}

const resolutionText = (resolution: ClosureFindingResolution | undefined): string => {
  if (resolution === undefined) return "unresolved";
  switch (resolution.kind) {
    case "fixed-and-re-reviewed":
      return `fixed and re-reviewed: ${resolution.evidence}`;
    case "linked-beta-story":
      return `linked to ${resolution.storyId}: ${resolution.rationale}; sources: ${resolution.sources.join("; ")}`;
  }
};

const findingText = (finding: ClosureFindingReport): string =>
  `${finding.severity}: ${finding.title}; sources: ${finding.sources.join("; ")}; resolution: ${resolutionText(finding.resolution)}`;

export const renderClosureReviewMarkdown = (report: ClosureReviewReport): string => {
  const lines = [
    "# Beta 1 Closure Review",
    "",
    `schemaVersion: ${report.schemaVersion}`,
    `approved: ${report.approved}`,
    "",
    "## Lanes",
  ];
  for (const lane of report.lanes) {
    const suffix = lane.inconclusiveClass === undefined ? "" : ` (${lane.inconclusiveClass})`;
    lines.push(`- ${lane.id}: ${lane.disposition}${suffix}`);
    lines.push(`  - scope: ${lane.scope}`);
    lines.push(`  - inputs: ${lane.inputs.join("; ")}`);
    lines.push(`  - commands/tools: ${lane.commandsOrTools.join("; ")}`);
    lines.push(`  - evidence: ${lane.evidence.join("; ")}`);
    lines.push(...lane.findings.map((finding) => `  - finding: ${findingText(finding)}`));
    lines.push(`  - residual risks: ${lane.residualRisks.join("; ")}`);
  }
  if (report.errors.length > 0)
    lines.push("", "## Blocking Errors", ...report.errors.map((error) => `- ${error}`));
  return `${lines.join("\n")}\n`;
};

export const writeClosureReviewOutputs = async ({
  report,
  reportPath,
  notePath,
}: WriteClosureReviewOutputsInput): Promise<void> => {
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(notePath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(notePath, renderClosureReviewMarkdown(report));
};
