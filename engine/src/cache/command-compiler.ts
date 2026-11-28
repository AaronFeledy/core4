import type {
  BunShellScriptInspection,
  BunShellScriptProblem,
  DiscoveredBunShellScript,
} from "@lando/landofile/bun-sh-discovery";
import { normalizeBunShellScript } from "@lando/landofile/bun-sh-metadata";
import type { LandofileProvenance } from "@lando/landofile/provenance";
import {
  type ToolingNormalizationSource,
  normalizeToolingTask,
  toolingCompileResult,
} from "@lando/landofile/tooling-normalize";
import { getLandofileValueSource } from "@lando/landofile/validation";
import { boundedDiagnosticSummary, projectToolingDiagnostic } from "@lando/sdk/command-result";
import type { AppPlan, LandofileShape, ValidationIssue } from "@lando/sdk/schema";
import { Result } from "effect";
import { type EffectiveTooling, launcherServicesForPlan } from "../planner/effective-tooling.ts";
import { primaryServiceName } from "../planner/primary-service.ts";
import { staticToolingLauncher } from "../tooling/launchers.ts";
import type { CommandIndexEntry, CommandLoadError } from "./command-index.ts";
import { toolingRunSummary } from "./tooling-run-summary.ts";

const compareOrdinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

interface ToolingCommandSources {
  readonly sourcePath: string;
  readonly provenance?: LandofileProvenance | undefined;
  readonly internalToolingTasks?: readonly string[] | undefined;
  readonly effectiveTooling?: EffectiveTooling | undefined;
  readonly toolingSource?: (name: string) => ToolingNormalizationSource;
  readonly plan?: AppPlan;
}

export const compileToolingCommands = (
  landofile: LandofileShape,
  redact: (text: string) => string,
  options: ToolingCommandSources,
): ReadonlyArray<CommandIndexEntry> => {
  const effectiveTooling = options.effectiveTooling ?? landofile.tooling;
  if (effectiveTooling === undefined) return [];
  const internal = new Set(options.internalToolingTasks ?? options.provenance?.internalToolingTasks ?? []);
  const launcherContext =
    options.plan === undefined
      ? Object.keys(landofile.services ?? {}).length === 0
        ? { services: {}, primary: undefined }
        : undefined
      : {
          services: launcherServicesForPlan(options.plan),
          primary: primaryServiceName(options.plan.services),
        };
  return Object.entries(effectiveTooling)
    .sort(([a], [b]) => compareOrdinal(a, b))
    .map(([name, authored]): CommandIndexEntry => {
      const identity = {
        id: `app:${name}`,
        summary: authored.description ?? authored.summary ?? "",
        sourceKind: "tooling" as const,
        visibility: internal.has(name) ? ("internal" as const) : ("public" as const),
      };
      const source = options.toolingSource?.(name) ?? {
        path: getLandofileValueSource(options.provenance, ["tooling", name])?.file ?? options.sourcePath,
        locate: (path: Parameters<typeof getLandofileValueSource>[1]) =>
          getLandofileValueSource(options.provenance, path),
      };
      if (authored.disabled === true)
        return { ...identity, _tag: "Disabled", source: { path: source.path, task: name } };
      const declaration = normalizeToolingTask(name, authored, source);
      const launcher =
        launcherContext === undefined || Result.isFailure(declaration)
          ? undefined
          : staticToolingLauncher(authored, launcherContext);
      const normalized =
        launcher === undefined
          ? declaration
          : Result.flatMap(declaration, (task) =>
              Result.map(toolingCompileResult(name, launcher, source), () => task),
            );
      if (Result.isFailure(normalized))
        return {
          ...identity,
          _tag: "Unavailable",
          // Storage bound only; publication bounds again with the invocation redactor.
          diagnostic: projectToolingDiagnostic(normalized.failure, { redactString: redact }),
        };
      const task = normalized.success;
      const runs = toolingRunSummary(
        task,
        launcher !== undefined && Result.isSuccess(launcher) ? launcher.success[0] : undefined,
      );
      let service: string | undefined;
      switch (task.service?.kind) {
        case "service":
          service = task.service.name;
          break;
        case "host":
        case "flag":
        case undefined:
          break;
        default:
          task.service satisfies never;
      }
      return {
        ...identity,
        _tag: "Ready",
        ...(service === undefined ? {} : { service }),
        input: task.input,
        ...(runs === undefined ? {} : { runs }),
        ...(task.wrapper ? { wrapper: true as const } : {}),
      };
    });
};

export const compileBunShellScriptCommand = (script: DiscoveredBunShellScript) =>
  Result.map(normalizeBunShellScript(script), (task): CommandIndexEntry => {
    const identity = {
      id: script.id,
      summary: task.summary,
      visibility: "public" as const,
      sourceKind: "bun-script" as const,
    };
    if (task.disabled)
      return { ...identity, _tag: "Disabled", source: { path: script.path, task: script.id.slice(4) } };
    return {
      ...identity,
      _tag: "Ready",
      service: task.rawService,
      ...(script.relativePath.length + ".lando/scripts/".length > 512
        ? {}
        : { runs: { kind: "script" as const, path: `.lando/scripts/${script.relativePath}` } }),
      input: task.input,
      ...(task.readsRouteFacts ? { readsRouteFacts: true as const } : {}),
    };
  });

export const compileBunShellScriptCommands = (
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
): ReadonlyArray<CommandIndexEntry> =>
  scripts.map((script) => Result.getOrThrowWith(compileBunShellScriptCommand(script), (error) => error));

export const compileAppCommands = (
  landofile: LandofileShape,
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
  options: ToolingCommandSources & {
    readonly redact: (text: string) => string;
  },
): ReadonlyArray<CommandIndexEntry> => {
  const toolingEntries = compileToolingCommands(landofile, options.redact, options);
  const seen = new Set(toolingEntries.map((entry) => entry.id));
  const merged: CommandIndexEntry[] = [...toolingEntries];
  for (const entry of compileBunShellScriptCommands(scripts)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged.sort((a, b) => compareOrdinal(a.id, b.id));
};

const MAX_SCRIPT_ISSUES = 8;
const MAX_PATH_SEGMENT_BYTES = 256;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

/** Redact first, then bound one JSON-encoded path segment with a truncation marker. */
const boundedPathSegment = (segment: string, redact: (text: string) => string): string => {
  const redacted = redact(segment);
  if (Buffer.byteLength(JSON.stringify(redacted)) <= MAX_PATH_SEGMENT_BYTES) return redacted;
  const characters = Array.from(redacted);
  let end = characters.length;
  while (end > 0) {
    const candidate = `${characters.slice(0, end).join("")}...`;
    const bytes = Buffer.byteLength(JSON.stringify(candidate));
    if (bytes <= MAX_PATH_SEGMENT_BYTES) return candidate;
    end -= Math.max(1, Math.ceil((bytes - MAX_PATH_SEGMENT_BYTES) / 6));
  }
  return "...";
};

const reportedIssues = (problem: BunShellScriptProblem): readonly ValidationIssue[] => {
  const reported = problem.error._tag === "BunShellScriptFrontMatterError" ? problem.error.issues : undefined;
  return reported?.length
    ? reported
    : [
        {
          path: problem.path,
          ...(problem.reason === undefined ? {} : { reason: problem.reason }),
          message: problem.message,
          ...(problem.suggestion === undefined ? {} : { suggestion: problem.suggestion }),
        },
      ];
};

/**
 * One bounded diagnostic for every problem sharing a script id. Issues from each problem are
 * merged in inspection order and deduped by path, then trimmed until the decoder's bound holds,
 * so the writer never stores a diagnostic the reader rejects.
 */
export const scriptLoadError = (
  problems: BunShellScriptProblem | readonly BunShellScriptProblem[],
  redact: (text: string) => string,
) => {
  const group = Array.isArray(problems) ? problems : [problems];
  const [first] = group;
  if (first === undefined) throw new Error("A script diagnostic needs at least one problem.");
  const bound = (value: string) => boundedDiagnosticSummary(redact(value));
  const message = bound(first.error.message);
  const remediation = bound(`Run lando app:config:lint to see every finding. ${first.error.remediation}`);
  const seen = new Set<string>();
  const collected = group.flatMap((problem) =>
    reportedIssues(problem).flatMap((issue) => {
      const path = issue.path.map((segment) =>
        typeof segment === "string" ? boundedPathSegment(segment, redact) : segment,
      );
      const key = JSON.stringify(path);
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          path,
          ...(issue.reason === undefined ? {} : { reason: issue.reason }),
          ...(issue.rule === "landofile.tooling" ? { rule: issue.rule } : {}),
          message: bound(issue.message),
          ...(issue.suggestion === undefined ? {} : { suggestion: bound(issue.suggestion) }),
          source: { layer: "script" as const, file: bound(problem.file), path },
        },
      ];
    }),
  );
  let kept = collected.slice(0, MAX_SCRIPT_ISSUES);
  const assemble = (issues: typeof kept) => ({
    _tag: first.error._tag,
    message,
    remediation,
    issues,
    omittedIssueCount: collected.length - issues.length,
  });
  let diagnostic = assemble(kept);
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(diagnostic)) > MAX_DIAGNOSTIC_BYTES) {
    kept = kept.slice(0, -1);
    diagnostic = assemble(kept);
  }
  return diagnostic satisfies CommandLoadError;
};

export const compileInspectedAppCommands = (
  options: ToolingCommandSources & {
    readonly landofile: LandofileShape;
    readonly inspection: BunShellScriptInspection;
    readonly redact: (text: string) => string;
  },
): readonly CommandIndexEntry[] => {
  const entries = [...compileAppCommands(options.landofile, options.inspection.scripts, options)];
  const seen = new Set(entries.map((entry) => entry.id));
  const grouped = new Map<string, BunShellScriptProblem[]>();
  for (const problem of options.inspection.problems) {
    if (problem.io) throw problem.error;
    if (problem.id === undefined || seen.has(problem.id)) continue;
    grouped.set(problem.id, [...(grouped.get(problem.id) ?? []), problem]);
  }
  for (const [id, problems] of grouped) {
    entries.push({
      id,
      summary: "Unavailable script",
      _tag: "Unavailable",
      visibility: "public",
      sourceKind: "bun-script",
      diagnostic: scriptLoadError(problems, options.redact),
    });
  }
  return entries.sort((a, b) => compareOrdinal(a.id, b.id));
};
