import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@lando/state-store/atomic";

import type { InstalledPluginRegistryEntry } from "./installed-registry.ts";

export interface LinkedPluginEntry {
  readonly source: "linked";
  readonly linkedPath: string;
  readonly registryEntry: string;
  readonly previousRegistry?: InstalledPluginRegistryEntry;
}

export type LinkedPluginState = Record<string, LinkedPluginEntry>;

const linkedStatePath = (pluginsRoot: string): string => join(pluginsRoot, ".lando-linked.json");

export const readLinkedState = async (pluginsRoot: string): Promise<LinkedPluginState> => {
  const path = linkedStatePath(pluginsRoot);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as LinkedPluginState;
};

export const writeLinkedState = async (pluginsRoot: string, state: LinkedPluginState): Promise<void> => {
  const path = linkedStatePath(pluginsRoot);
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
};
