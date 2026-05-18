import type { LandofileShape, PluginManifest, ToolingTaskShape } from "@lando/sdk/schema";

import type { CommandIndexEntry } from "./command-index.ts";

const summaryFor = (task: ToolingTaskShape): string => task.description ?? task.summary ?? "";

export const compileToolingCommands = (landofile: LandofileShape): ReadonlyArray<CommandIndexEntry> => {
  const tooling = landofile.tooling;
  if (tooling === undefined) return [];
  return Object.entries(tooling)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, task]) => ({
      id: `app:${name}`,
      summary: summaryFor(task),
      hidden: false,
      ...(task.service === undefined ? {} : { service: task.service }),
    }));
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
