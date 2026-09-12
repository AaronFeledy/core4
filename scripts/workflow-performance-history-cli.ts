#!/usr/bin/env bun
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  type WorkflowPerformanceHistoryCandidate,
  buildWorkflowPerformanceHistory,
  renderWorkflowPerformanceHistoryMarkdown,
} from "./workflow-performance-history.ts";
import {
  decodeWorkflowPerformanceReport,
  evaluateWorkflowPerformanceReport,
} from "./workflow-performance-report.ts";

type CliOptions = {
  readonly current: string;
  readonly index: string;
  readonly artifactRoot: string;
  readonly summary: string;
  readonly markdown: string;
};

class WorkflowPerformanceHistoryArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPerformanceHistoryArgumentError";
  }
}

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

const requiredPath = (args: readonly string[], flag: string): string => {
  const value = valueAfter(args, flag);
  if (value === undefined || value.length === 0)
    throw new WorkflowPerformanceHistoryArgumentError(`Missing ${flag}.`);
  return resolve(value);
};

const parseOptions = (args: readonly string[]): CliOptions => ({
  current: requiredPath(args, "--current"),
  index: requiredPath(args, "--index"),
  artifactRoot: requiredPath(args, "--artifact-root"),
  summary: requiredPath(args, "--summary"),
  markdown: requiredPath(args, "--markdown"),
});

const readPriorCandidates = async (
  options: CliOptions,
): Promise<readonly WorkflowPerformanceHistoryCandidate[]> => {
  const index = await readFile(options.index, "utf8");
  const candidates: WorkflowPerformanceHistoryCandidate[] = [];
  for (const line of index.split("\n")) {
    if (line.length === 0) continue;
    const [runId, createdAt, conclusion] = line.split("\t");
    if (runId === undefined || createdAt === undefined || conclusion === undefined) continue;
    const path = join(options.artifactRoot, runId, "report.json");
    const report = (await Bun.file(path).exists()) ? JSON.parse(await readFile(path, "utf8")) : undefined;
    candidates.push({ runId, createdAt, conclusion, ...(report === undefined ? {} : { report }) });
  }
  return candidates;
};

const main = async (args: readonly string[]): Promise<void> => {
  const options = parseOptions(args);
  const current = decodeWorkflowPerformanceReport(JSON.parse(await readFile(options.current, "utf8")));
  const currentCandidate: WorkflowPerformanceHistoryCandidate = {
    runId: current.run.id,
    createdAt: current.run.generatedAt,
    conclusion: evaluateWorkflowPerformanceReport(current).exitCode === 0 ? "success" : "failure",
    report: current,
  };
  const summary = buildWorkflowPerformanceHistory(current, [
    currentCandidate,
    ...(await readPriorCandidates(options)),
  ]);
  const markdown = renderWorkflowPerformanceHistoryMarkdown(summary);
  await Promise.all([
    mkdir(dirname(options.summary), { recursive: true }),
    mkdir(dirname(options.markdown), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(options.summary, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(options.markdown, markdown),
  ]);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary !== undefined && stepSummary.length > 0) await appendFile(stepSummary, markdown);
  process.stdout.write(`${JSON.stringify({ rows: summary.rows.length, summary: options.summary })}\n`);
};

if (import.meta.main) await main(process.argv.slice(2));
