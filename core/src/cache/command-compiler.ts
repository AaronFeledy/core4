import type { LandofileShape, PluginManifest, ToolingTaskShape } from "@lando/sdk/schema";

import type { DiscoveredBunShellScript } from "../landofile/bun-sh-discovery.ts";
import type { CommandIndexEntry } from "./command-index.ts";

const summaryForTask = (task: ToolingTaskShape): string => task.description ?? task.summary ?? "";

export const compileToolingCommands = (landofile: LandofileShape): ReadonlyArray<CommandIndexEntry> => {
  const tooling = landofile.tooling;
  if (tooling === undefined) return [];
  return Object.entries(tooling)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, task]) => ({
      id: `app:${name}`,
      summary: summaryForTask(task),
      hidden: false,
      ...(task.service === undefined ? {} : { service: task.service }),
    }));
};

export const compileBunShellScriptCommands = (
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
): ReadonlyArray<CommandIndexEntry> =>
  scripts.map((script) => ({
    id: script.id,
    summary: script.summary,
    hidden: false,
    service: script.service,
  }));

export const compileAppCommands = (
  landofile: LandofileShape,
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
): ReadonlyArray<CommandIndexEntry> => {
  const toolingEntries = compileToolingCommands(landofile);
  const seen = new Set(toolingEntries.map((entry) => entry.id));
  const merged: CommandIndexEntry[] = [...toolingEntries];
  for (const entry of compileBunShellScriptCommands(scripts)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged.sort((a, b) => a.id.localeCompare(b.id));
};

export const compilePluginCommands = (
  manifests: ReadonlyArray<PluginManifest>,
): ReadonlyArray<CommandIndexEntry> => {
  const seen = new Set<string>();
  const entries: CommandIndexEntry[] = [];
  for (const manifest of manifests) {
    for (const id of manifest.contributes?.commands ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, summary: "", hidden: false });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
};
