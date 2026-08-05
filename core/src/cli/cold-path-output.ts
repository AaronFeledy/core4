import { renderRecipeCatalog } from "../recipes/catalog-render.ts";
import { getRecipeCatalog } from "../recipes/catalog.ts";
import { CORE_VERSION } from "../version.ts";
import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest.ts";

type ColdCommandEntry = {
  readonly aliases: ReadonlyArray<string>;
  readonly spec: {
    readonly id: string;
    readonly summary: string;
    readonly namespace: string;
  };
  readonly hidden: boolean;
};

type ColdTopicEntry = {
  readonly description: string;
  readonly hidden?: boolean;
};

export const renderColdRootHelp = (): string => {
  const entries: ReadonlyArray<readonly [string, ColdCommandEntry]> = Object.entries(
    COMMAND_REGISTRY_MANIFEST.commands,
  );
  const namespaces = new Map<string, Array<ColdCommandEntry>>();
  const aliases: Array<readonly [string, string]> = [];
  for (const [, entry] of entries) {
    if (entry.hidden) continue;
    const namespace = entry.spec.id.split(":", 1)[0] ?? entry.spec.namespace;
    const namespaceEntries = namespaces.get(namespace) ?? [];
    namespaceEntries.push(entry);
    namespaces.set(namespace, namespaceEntries);
    for (const alias of entry.aliases) {
      if (!alias.startsWith("-")) aliases.push([alias, entry.spec.id]);
    }
  }
  const topics: ReadonlyArray<readonly [string, ColdTopicEntry]> = Object.entries(
    COMMAND_REGISTRY_MANIFEST.topics,
  );
  const rootTopicLines = topics
    .filter(([topic, metadata]) => !topic.includes(":") && metadata.hidden !== true)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([topic, metadata]) => `  ${topic.padEnd(6)}${metadata.description}`);

  const lines = [
    `Lando v4 core: runtime, planner, command registry, and library API.

VERSION
  @lando/core/${CORE_VERSION} ${process.platform}-${process.arch} node-${process.version}

USAGE
  $ lando [COMMAND]

TOPICS
${rootTopicLines.join("\n")}

COMMANDS`,
  ];
  for (const [namespace, namespaceEntries] of [...namespaces].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`  ${namespace}`);
    for (const { spec } of namespaceEntries) lines.push(`    ${spec.id.padEnd(30)} ${spec.summary}`);
  }
  lines.push("", "ALIASES");
  for (const [alias, canonicalId] of aliases.sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`  ${alias} -> ${canonicalId}`);
  }
  return lines.join("\n");
};

export const renderColdRecipesList = (): string => renderRecipeCatalog(getRecipeCatalog());
