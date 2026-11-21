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
import type { AppPlan, LandofileShape } from "@lando/sdk/schema";
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

const commandLoadError = (
  error: { readonly _tag: string; readonly message: string; readonly remediation: string },
  redact: (text: string) => string,
): CommandLoadError => {
  const bound = (text: string): string => {
    return boundedDiagnosticSummary(redact(text));
  };
  return {
    _tag: error._tag,
    message: bound(error.message),
    remediation: bound(`Run lando app:config:lint to see every finding. ${error.remediation}`),
  };
};

export const scriptLoadError = (problem: BunShellScriptProblem, redact: (text: string) => string) =>
  commandLoadError(problem.error, redact);

export const compileInspectedAppCommands = (
  options: ToolingCommandSources & {
    readonly landofile: LandofileShape;
    readonly inspection: BunShellScriptInspection;
    readonly redact: (text: string) => string;
  },
): readonly CommandIndexEntry[] => {
  const entries = [...compileAppCommands(options.landofile, options.inspection.scripts, options)];
  const seen = new Set(entries.map((entry) => entry.id));
  for (const problem of options.inspection.problems) {
    if (problem.io) throw problem.error;
    if (problem.id === undefined || seen.has(problem.id)) continue;
    seen.add(problem.id);
    entries.push({
      id: problem.id,
      summary: "Unavailable script",
      _tag: "Unavailable",
      visibility: "public",
      sourceKind: "bun-script",
      diagnostic: scriptLoadError(problem, options.redact),
    });
  }
  return entries.sort((a, b) => compareOrdinal(a.id, b.id));
};
