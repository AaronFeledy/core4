#!/usr/bin/env bun
import { readFile } from "node:fs/promises";

export {
  evaluateClosureReviewInput,
  failedClosureReviewReport,
  type ClosureDisposition,
  type ClosureFindingReport,
  type ClosureFindingResolution,
  type ClosureFindingResolutionFixed,
  type ClosureFindingResolutionLinkedStory,
  type ClosureInconclusiveClass,
  type ClosureLaneId,
  type ClosureLaneReport,
  type ClosureReviewReport,
} from "./closure-review-report.ts";
export {
  renderClosureReviewMarkdown,
  writeClosureReviewOutputs,
  type WriteClosureReviewOutputsInput,
} from "./closure-review-output.ts";

import { writeClosureReviewOutputs } from "./closure-review-output.ts";
import { evaluateClosureReviewInput, failedClosureReviewReport } from "./closure-review-report.ts";

interface ClosureReviewCliOptions {
  readonly input: string;
  readonly report: string;
  readonly note: string;
  readonly prd: string;
}

class ClosureReviewCliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClosureReviewCliArgumentError";
  }
}

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
};

const parseCliOptions = (args: readonly string[]): ClosureReviewCliOptions => {
  const input = valueAfter(args, "--input");
  const report = valueAfter(args, "--report");
  const note = valueAfter(args, "--note");
  const prd = valueAfter(args, "--prd") ?? "spec/beta-1/prd.json";
  if (input === undefined || report === undefined || note === undefined) {
    throw new ClosureReviewCliArgumentError(
      "Usage: closure-review.ts --input <input.json> --report <report.json> --note <note.md> [--prd <prd.json>]",
    );
  }
  return { input, report, note, prd };
};

const parseJson = (text: string): unknown => JSON.parse(text);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseFailingStoryIds = (value: unknown): readonly string[] | undefined => {
  if (!isRecord(value) || !Array.isArray(value.userStories)) return undefined;
  const ids: string[] = [];
  for (const story of value.userStories) {
    if (!isRecord(story) || typeof story.id !== "string" || typeof story.passes !== "boolean")
      return undefined;
    if (!story.passes) ids.push(story.id);
  }
  return ids;
};

const failingStoryIdsFromPrdPath = async (path: string): Promise<readonly string[] | undefined> => {
  try {
    return parseFailingStoryIds(parseJson(await readFile(path, "utf8")));
  } catch (cause) {
    if (cause instanceof Error) return undefined;
    throw cause;
  }
};

const reportFromInputPath = async (inputPath: string, prdPath: string) => {
  try {
    const failingStoryIds = await failingStoryIdsFromPrdPath(prdPath);
    if (failingStoryIds === undefined) return failedClosureReviewReport(["Beta 1 PRD JSON shape is invalid"]);
    return evaluateClosureReviewInput(parseJson(await readFile(inputPath, "utf8")), failingStoryIds);
  } catch (cause) {
    if (cause instanceof SyntaxError)
      return failedClosureReviewReport([`closure review input is not valid JSON: ${cause.message}`]);
    if (cause instanceof Error)
      return failedClosureReviewReport([`closure review input could not be read: ${cause.message}`]);
    throw cause;
  }
};

const main = async (): Promise<void> => {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    const report = await reportFromInputPath(options.input, options.prd);
    await writeClosureReviewOutputs({ report, reportPath: options.report, notePath: options.note });
    console.log(JSON.stringify({ report: options.report, note: options.note, approved: report.approved }));
    process.exit(report.approved ? 0 : 1);
  } catch (cause) {
    if (cause instanceof ClosureReviewCliArgumentError) {
      console.error(cause.message);
      process.exit(1);
    }
    throw cause;
  }
};

if (import.meta.main) await main();
