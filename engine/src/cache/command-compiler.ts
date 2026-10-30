import type { LandofileShape, PluginManifest } from "@lando/sdk/schema";
import { Result } from "effect";

import type { DiscoveredBunShellScript } from "@lando/landofile/bun-sh-discovery";
import { normalizeBunShellScript } from "@lando/landofile/bun-sh-metadata";
import { getInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import type { EffectiveTooling } from "../planner/effective-tooling.ts";
import type { CommandIndexEntry } from "./command-index.ts";

const contributionId = (entry: string | { readonly id: string }): string =>
  typeof entry === "string" ? entry : entry.id;
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

export const compilePluginCommands = (
  manifests: ReadonlyArray<PluginManifest>,
): ReadonlyArray<CommandIndexEntry> => {
  const seen = new Set<string>();
  const entries: CommandIndexEntry[] = [];
  for (const manifest of manifests) {
    for (const command of manifest.contributes?.commands ?? []) {
      const id = contributionId(command);
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, summary: "", hidden: false });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
};
