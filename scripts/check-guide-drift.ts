#!/usr/bin/env bun
import { resolve } from "node:path";

import { type ChangeComparison, GitChangeError, discoverChanges } from "./git-changes.ts";
import { checkContainerCommandBaselineOnDisk } from "./guides/container-command-baseline.ts";
import { guideFixturesRoot, pathTouchesGuide } from "./guides/discovery.ts";
import {
  appendStepSummary,
  formatGitChangeSummary,
  formatGuideDriftOutput,
  formatGuideDriftSummary,
  pathList,
} from "./guides/drift-report.ts";
import {
  type HomeGuideEntry,
  type HomeGuideRegistry,
  loadHomeGuideRegistry,
} from "./guides/home-guide-registry.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const DEFAULT_BASE_REF = "origin/main";

const MIN_SKIP_REASON_LENGTH = 24;

export interface GuideDriftFailure {
  readonly sourcePath?: string;
  readonly code: string;
  readonly message: string;
  /** Map and container-baseline failures are never waived by a skip tag. */
  readonly waivable: boolean;
}

export interface GuideDriftTouched {
  readonly feature: string;
  readonly guide: string;
  readonly paths: readonly string[];
  readonly satisfied: boolean;
}

export interface GuideDriftEvaluation {
  readonly failures: readonly GuideDriftFailure[];
  readonly touched: readonly GuideDriftTouched[];
  readonly exempted: readonly GuideDriftTouched[];
  readonly skip?: { readonly reason: string };
}

interface GuideDriftInput {
  readonly registry: HomeGuideRegistry;
  readonly changedPaths: readonly string[];
  /** Map and baseline failures, already ordered and never waivable. */
  readonly baseFailures?: readonly GuideDriftFailure[];
  readonly prBody: string;
}

const touchedFeatures = (
  registry: HomeGuideRegistry,
  changedPaths: readonly string[],
): readonly GuideDriftTouched[] => {
  const touched: Array<GuideDriftTouched> = [];
  for (const entry of registry.entries) {
    const paths = changedPaths.filter((path) =>
      registry.ownersOf(path).some((owner) => owner.feature === entry.feature),
    );
    if (paths.length === 0) continue;
    const guide = registry.guide(entry.guide);
    const guideId = guide?.kind === "parsed" ? guide.guideId : undefined;
    const satisfied = changedPaths.some((path) =>
      pathTouchesGuide(path, { guidePath: entry.guide, ...(guideId === undefined ? {} : { guideId }) }),
    );
    touched.push({ feature: entry.feature, guide: entry.guide, paths, satisfied });
  }
  return touched.sort((left, right) => left.feature.localeCompare(right.feature));
};

const guideNotTouched = (touched: GuideDriftTouched, registry: HomeGuideRegistry): GuideDriftFailure => {
  const guide = registry.guide(touched.guide);
  const guideId = guide?.kind === "parsed" ? guide.guideId : undefined;
  const fixtures = guideId === undefined ? undefined : guideFixturesRoot(guideId);
  const notTouched =
    fixtures === undefined
      ? `but its home guide "${touched.guide}" was not touched`
      : `but neither its home guide "${touched.guide}" nor a file under "${fixtures}" was touched`;
  const remedy =
    fixtures === undefined
      ? `Update "${touched.guide}"`
      : `Update "${touched.guide}" or a file under "${fixtures}"`;
  return {
    code: "drift.guide-not-touched",
    message: `${pathList(touched.paths)} changed for feature "${touched.feature}", ${notTouched}. ${remedy}, then run \`bun run test:affected --run\`. If no guide change is needed, add \`Guide-Coverage-Skip: <reason of at least ${MIN_SKIP_REASON_LENGTH} characters>\` to the pull request body; preview it locally with \`GUIDE_DRIFT_PR_BODY='Guide-Coverage-Skip: <reason>' bun run check:guide-drift\`.`,
    waivable: true,
  };
};

const evaluateGuideDrift = (input: GuideDriftInput): GuideDriftEvaluation => {
  const failures = [...(input.baseFailures ?? [])];
  const touched = touchedFeatures(input.registry, input.changedPaths);

  const skipLines = [...input.prBody.matchAll(/^Guide-Coverage-Skip:[ \t]*(.*)$/gm)].map((match) => ({
    line: input.prBody.slice(0, match.index).split("\n").length,
    reason: (match[1] ?? "").trim(),
  }));
  let skip: { readonly reason: string } | undefined;
  if (skipLines.length > 1) {
    failures.push({
      code: "drift.skip-ambiguous",
      message: `the pull request body has ${skipLines.length} "Guide-Coverage-Skip:" lines (${skipLines
        .map((entry) => `line ${entry.line}: "${entry.reason}"`)
        .join("; ")}). Keep exactly one so the exemption is unambiguous.`,
      waivable: false,
    });
  } else if (skipLines.length === 1) {
    const reason = skipLines[0]?.reason ?? "";
    if (reason.length >= MIN_SKIP_REASON_LENGTH) skip = { reason };
    else
      failures.push({
        code: "drift.skip-reason-too-short",
        message: `the pull request body declares "Guide-Coverage-Skip:" with a ${reason.length}-character reason, but the gate requires at least ${MIN_SKIP_REASON_LENGTH} characters explaining why no guide change is needed.`,
        waivable: false,
      });
  }

  const exempted: Array<GuideDriftTouched> = [];
  for (const feature of touched) {
    if (feature.satisfied) continue;
    if (skip !== undefined) exempted.push(feature);
    else failures.push(guideNotTouched(feature, input.registry));
  }

  return {
    failures,
    touched,
    exempted,
    ...(skip === undefined ? {} : { skip }),
  };
};

const parseBaseArgument = (args: ReadonlyArray<string>): string | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--base") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--base requires a ref");
      return value;
    }
    if (arg.startsWith("--base=")) return arg.slice("--base=".length);
  }
  return undefined;
};

type ComparisonChoice = { readonly comparison: ChangeComparison } | { readonly problem: string };

/**
 * Both SHA variables select a commit range. Otherwise the gate compares the
 * merge base of the base ref with the working tree, so local runs include
 * uncommitted work.
 */
const comparisonFrom = (env: NodeJS.ProcessEnv, args: ReadonlyArray<string>): ComparisonChoice => {
  const baseSha = env.GUIDE_DRIFT_BASE_SHA;
  const headSha = env.GUIDE_DRIFT_HEAD_SHA;
  const baseArgument = parseBaseArgument(args);
  if (baseSha !== undefined || headSha !== undefined) {
    if (baseArgument !== undefined) {
      return {
        problem: `--base ${baseArgument} selects a working-tree comparison, but GUIDE_DRIFT_BASE_SHA and GUIDE_DRIFT_HEAD_SHA select a commit range. Pass --base with neither SHA variable, or drop --base and set both SHAs.`,
      };
    }
    if (baseSha === undefined || headSha === undefined) {
      return {
        problem:
          "GUIDE_DRIFT_BASE_SHA and GUIDE_DRIFT_HEAD_SHA must be set together to compare two commits; set both, or neither to compare the base ref with the working tree.",
      };
    }
    return { comparison: { kind: "commits", base: baseSha, head: headSha } };
  }
  return {
    comparison: {
      kind: "working-tree",
      baseRef: baseArgument ?? env.GUIDE_DRIFT_BASE_REF ?? DEFAULT_BASE_REF,
    },
  };
};

export interface GuideDriftGateOptions {
  readonly root?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly args?: ReadonlyArray<string>;
  /** Test seam: an injected map instead of the checked-in HOME_GUIDES. */
  readonly entries?: readonly HomeGuideEntry[];
}

interface GuideDriftGateResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const runGuideDriftGate = async (
  options: GuideDriftGateOptions = {},
): Promise<GuideDriftGateResult> => {
  const root = options.root ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const args = options.args ?? process.argv.slice(2);
  const choice = comparisonFrom(env, args);
  if ("problem" in choice) {
    await appendStepSummary(`## Guide Drift\n\nStatus: failed.\n\n- ${choice.problem}\n`, env);
    return { exitCode: 1, stdout: "", stderr: `${choice.problem}\n` };
  }

  const gitFailure = async (error: GitChangeError): Promise<GuideDriftGateResult> => {
    await appendStepSummary(formatGitChangeSummary(error), env);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${error._tag}: ${error.message}\n${error.remediation}\n`,
    };
  };

  let changes: Awaited<ReturnType<typeof discoverChanges>>;
  try {
    changes = await discoverChanges(root, choice.comparison);
  } catch (error) {
    if (!(error instanceof GitChangeError)) throw error;
    return gitFailure(error);
  }

  const registry = await loadHomeGuideRegistry(
    root,
    options.entries === undefined ? {} : { entries: options.entries },
  );
  // The container-command baseline compares the checked-out tree with the base
  // itself, never the merge base: an older ancestor's allowance cannot excuse growth.
  let baseline: Awaited<ReturnType<typeof checkContainerCommandBaselineOnDisk>>;
  try {
    baseline = await checkContainerCommandBaselineOnDisk(root, changes.base);
  } catch (error) {
    if (!(error instanceof GitChangeError)) throw error;
    return gitFailure(error);
  }
  const baseFailures: readonly GuideDriftFailure[] = [
    ...registry.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      waivable: false,
    })),
    ...baseline.diagnostics.map((diagnostic) => ({
      ...(diagnostic.sourcePath === undefined ? {} : { sourcePath: diagnostic.sourcePath }),
      code: diagnostic.code,
      message: diagnostic.message,
      waivable: false,
    })),
  ];
  const evaluation = evaluateGuideDrift({
    registry,
    changedPaths: changes.paths,
    baseFailures,
    prBody: env.GUIDE_DRIFT_PR_BODY ?? "",
  });

  const output = formatGuideDriftOutput(evaluation, changes, changes.paths);
  await appendStepSummary(formatGuideDriftSummary(evaluation, changes, changes.paths), env);

  return {
    exitCode: evaluation.failures.length === 0 ? 0 : 1,
    stdout: output.stdout,
    stderr: output.stderr,
  };
};

const main = async (): Promise<void> => {
  const result = await runGuideDriftGate();
  if (result.stdout !== "") process.stdout.write(`${result.stdout}\n`);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
};

if (import.meta.main) await main();
