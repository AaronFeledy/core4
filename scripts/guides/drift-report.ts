import { appendFile } from "node:fs/promises";
import type { GuideDriftEvaluation, GuideDriftFailure, GuideDriftTouched } from "../check-guide-drift.ts";
import type { GitChangeError } from "../git-changes.ts";

interface DriftComparison {
  readonly base: string;
  readonly mergeBase: string;
  readonly head?: string;
}

export const pathList = (paths: readonly string[]): string => paths.map((path) => `"${path}"`).join(", ");

const shortSha = (sha: string): string => sha.slice(0, 7);

const comparisonLine = (comparison: DriftComparison): string =>
  `merge base ${shortSha(comparison.mergeBase)} to ${
    comparison.head === undefined ? "working tree" : `commit ${shortSha(comparison.head)}`
  }`;

const formatFailure = (failure: GuideDriftFailure): string =>
  `${failure.sourcePath === undefined ? "" : `${failure.sourcePath}: `}${failure.code}: ${failure.message}`;

const touchedLine = (feature: GuideDriftTouched): string =>
  `${pathList(feature.paths)} -> ${feature.feature}: ${feature.guide} ${feature.satisfied ? "touched" : "not touched"}`;

const exemptedLine = (feature: GuideDriftTouched): string =>
  `${pathList(feature.paths)} -> ${feature.feature}: ${feature.guide} (exempted by Guide-Coverage-Skip)`;

interface GuideDriftOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export const formatGuideDriftOutput = (
  evaluation: GuideDriftEvaluation,
  comparison: DriftComparison,
  changedPaths: readonly string[],
): GuideDriftOutput => {
  const stdout: Array<string> = [`Comparison: ${comparisonLine(comparison)}`];
  for (const feature of evaluation.touched) if (feature.satisfied) stdout.push(touchedLine(feature));
  if (evaluation.failures.length === 0) {
    if (evaluation.touched.length === 0)
      stdout.push(`no covered paths changed (${changedPaths.length} changed paths compared)`);
    if (evaluation.skip !== undefined) {
      stdout.push(`Guide-Coverage-Skip accepted: ${evaluation.skip.reason}`);
      if (evaluation.exempted.length === 0)
        stdout.push("Guide-Coverage-Skip accepted, but no unsatisfied feature needed it.");
      for (const feature of evaluation.exempted) stdout.push(exemptedLine(feature));
    }
    stdout.push("Guide-drift gate passed.");
    return { stdout: stdout.join("\n"), stderr: "" };
  }

  const stderr: Array<string> = evaluation.failures.map(formatFailure);
  if (evaluation.skip !== undefined) {
    stderr.push(`Guide-Coverage-Skip accepted: ${evaluation.skip.reason}`);
    if (evaluation.exempted.length === 0) stderr.push("Guide-Coverage-Skip exempted no feature.");
    for (const feature of evaluation.exempted) stderr.push(exemptedLine(feature));
    if (evaluation.failures.some((failure) => !failure.waivable))
      stderr.push("Guide-Coverage-Skip does not waive the map or container-baseline failures listed above.");
  }
  stderr.push(
    `Guide-drift gate failed: ${evaluation.failures.length} finding${evaluation.failures.length === 1 ? "" : "s"}.`,
  );
  return { stdout: stdout.join("\n"), stderr: `${stderr.join("\n")}\n` };
};

const summaryList = (items: readonly string[]): string =>
  items.length === 0 ? "_None._" : items.map((item) => `- ${item}`).join("\n");

export const formatGuideDriftSummary = (
  evaluation: GuideDriftEvaluation,
  comparison: DriftComparison,
  changedPaths: readonly string[],
): string => {
  const status =
    evaluation.failures.length === 0
      ? evaluation.exempted.length > 0
        ? "passed with exemptions"
        : "passed"
      : "failed";
  const sections = ["## Guide Drift", `Status: ${status}.`, `Comparison: ${comparisonLine(comparison)}.`];
  sections.push(`Base: \`${comparison.base}\` (merge base \`${comparison.mergeBase}\`).`);
  if (evaluation.failures.length > 0)
    sections.push(`### Diagnostics\n${summaryList(evaluation.failures.map(formatFailure))}`);
  sections.push(`### Touched features\n${summaryList(evaluation.touched.map(touchedLine))}`);
  if (evaluation.skip !== undefined) {
    sections.push(
      `### Exempted by Guide-Coverage-Skip\nReason: ${evaluation.skip.reason}\n\n${summaryList(evaluation.exempted.map(exemptedLine))}`,
    );
    if (evaluation.exempted.length === 0) sections.push("It exempted no feature.");
    if (evaluation.failures.some((failure) => !failure.waivable))
      sections.push("It does not waive the map or container-baseline failures reported above.");
  }
  sections.push(`### Changed Files\n${summaryList(changedPaths.map((path) => `\`${path}\``))}`);
  return `${sections.join("\n\n")}\n`;
};

export const appendStepSummary = async (summary: string, env: NodeJS.ProcessEnv): Promise<void> => {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath.trim() === "") return;
  await appendFile(summaryPath, summary.endsWith("\n") ? summary : `${summary}\n`);
};

export const formatGitChangeSummary = (error: GitChangeError): string =>
  `## Guide Drift\n\nStatus: failed.\n\n### Git failure\n- GitChangeError: ${error.message}\n- Remediation: ${error.remediation}\n`;
