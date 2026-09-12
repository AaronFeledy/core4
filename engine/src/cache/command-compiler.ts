import type { LandofileShape, PluginManifest } from "@lando/sdk/schema";
import { Either } from "effect";

import type { DiscoveredBunShellScript } from "@lando/landofile/bun-sh-discovery";
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
    .flatMap(([name, authored]) => {
      // Preserve the synchronous API by throwing the tagged error into callers' Effect boundaries.
      const task = Either.getOrThrowWith(normalizeToolingTask(name, authored), (error) => error);
      if (task.disabled) return [];
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
      return [
        {
          id: `app:${name}`,
          summary: task.summary ?? "",
          hidden: internal.has(name),
          ...(service === undefined ? {} : { service }),
          ...(task.hasInput ? { input: { flags: task.flags, args: task.args } } : {}),
        },
      ];
    });
};

export const compileBunShellScriptCommands = (
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
): ReadonlyArray<CommandIndexEntry> =>
  scripts.map((script) => ({
    id: script.id,
    summary: script.summary,
    hidden: false,
    service: script.service,
    source: "bun-script" as const,
  }));

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
