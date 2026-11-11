import type {
  BunShellScriptInspection,
  BunShellScriptProblem,
  DiscoveredBunShellScript,
} from "@lando/landofile/bun-sh-discovery";
import { normalizeBunShellScript } from "@lando/landofile/bun-sh-metadata";
import { getInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import type { LandofileShape } from "@lando/sdk/schema";
import { Result } from "effect";
import type { EffectiveTooling } from "../planner/effective-tooling.ts";
import type { CommandIndexEntry } from "./command-index.ts";
import { toolingRunSummary } from "./tooling-run-summary.ts";

const compareOrdinal = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export const compileToolingCommands = (
  landofile: LandofileShape,
  effectiveTooling: EffectiveTooling | undefined = landofile.tooling,
): ReadonlyArray<CommandIndexEntry> => {
  if (effectiveTooling === undefined) return [];
  const internal = new Set(getInternalToolingTasks(landofile));
  return Object.entries(effectiveTooling)
    .sort(([a], [b]) => compareOrdinal(a, b))
    .map(([name, authored]) => {
      // Preserve the synchronous API by throwing the tagged error into callers' Effect boundaries.
      const task = Result.getOrThrowWith(normalizeToolingTask(name, authored), (error) => error);
      const runs = toolingRunSummary(task);
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
        id: `app:${name}`,
        summary: task.summary ?? "",
        hidden: internal.has(name) || task.disabled,
        ...(task.disabled ? { disabled: true as const } : {}),
        ...(service === undefined ? {} : { service }),
        input: task.input,
        ...(runs === undefined ? {} : { runs }),
        ...(task.wrapper ? { wrapper: true as const } : {}),
      };
    });
};

export const compileBunShellScriptCommand = (script: DiscoveredBunShellScript) =>
  Result.map(
    normalizeBunShellScript(script),
    (task): CommandIndexEntry => ({
      id: script.id,
      summary: task.summary,
      hidden: task.disabled,
      ...(task.disabled ? { disabled: true as const } : {}),
      service: task.rawService,
      source: "bun-script",
      ...(script.relativePath.length + ".lando/scripts/".length > 512
        ? {}
        : { runs: { kind: "script" as const, path: `.lando/scripts/${script.relativePath}` } }),
      input: task.input,
    }),
  );

export const compileBunShellScriptCommands = (
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
): ReadonlyArray<CommandIndexEntry> =>
  scripts.map((script) => Result.getOrThrowWith(compileBunShellScriptCommand(script), (error) => error));

export const compileAppCommands = (
  landofile: LandofileShape,
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
  effectiveTooling?: EffectiveTooling,
): ReadonlyArray<CommandIndexEntry> => {
  const toolingEntries = compileToolingCommands(landofile, effectiveTooling);
  const seen = new Set(toolingEntries.map((entry) => entry.id));
  const merged: CommandIndexEntry[] = [...toolingEntries];
  for (const entry of compileBunShellScriptCommands(scripts)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged.sort((a, b) => compareOrdinal(a.id, b.id));
};

export const scriptLoadError = (
  problem: BunShellScriptProblem,
  redact: (text: string) => string,
): NonNullable<CommandIndexEntry["loadError"]> => {
  const bound = (text: string): string => {
    const redacted = redact(text);
    let result = "";
    for (const character of redacted) {
      if (Buffer.byteLength(result + character) > 1024) break;
      result += character;
    }
    return result;
  };
  return {
    _tag: problem.error._tag,
    message: bound(problem.error.message),
    remediation: bound(`Run lando app:config:lint to see every finding. ${problem.error.remediation}`),
  };
};

export const compileInspectedAppCommands = (options: {
  readonly landofile: LandofileShape;
  readonly inspection: BunShellScriptInspection;
  readonly effectiveTooling?: EffectiveTooling | undefined;
  readonly redact: (text: string) => string;
}): readonly CommandIndexEntry[] => {
  const entries = [
    ...compileAppCommands(options.landofile, options.inspection.scripts, options.effectiveTooling),
  ];
  const seen = new Set(entries.map((entry) => entry.id));
  for (const problem of options.inspection.problems) {
    if (problem.io) throw problem.error;
    if (problem.id === undefined || seen.has(problem.id)) continue;
    seen.add(problem.id);
    entries.push({
      id: problem.id,
      summary: "Unavailable script",
      hidden: false,
      source: "bun-script",
      loadError: scriptLoadError(problem, options.redact),
    });
  }
  return entries.sort((a, b) => compareOrdinal(a.id, b.id));
};
