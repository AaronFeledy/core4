import { CORE_VERSION } from "@lando/engine/version";
import { getRecipeCatalog } from "../recipes/catalog";
import { renderRecipeCatalog } from "../recipes/catalog-render";
import { COMMAND_TOPICS } from "./command-topics";
import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest";
import { type HelpAliasPolicy, typeableName } from "./help-names";
import { shouldStyleHelp, bold as wrapBold, cyan as wrapCyan, dim as wrapDim } from "./help-style";
import { moreRows } from "./root-help-topics";
import { type ToolingMetadataStatus, toolingMetadataNotice } from "./tooling-cache-status";

export type ThisAppHelpRow = {
  readonly canonicalId: string;
  readonly primary: string;
  readonly extras: ReadonlyArray<string>;
  readonly summary: string;
};

export type ColdHelpStyle = {
  readonly style?: boolean;
  readonly thisAppRows?: ReadonlyArray<ThisAppHelpRow>;
  readonly aliasPolicy?: HelpAliasPolicy;
  readonly toolingMetadata?: ToolingMetadataStatus;
  readonly pluginRows?: ReadonlyArray<ThisAppHelpRow>;
  readonly pluginNotice?: string;
  readonly pluginTopics?: readonly { readonly token: string; readonly summary: string }[];
};

export const HELP_TOPICS = ["app", "apps", "plugin", "global", "recipes", "scratch"] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

const HELP_TOPIC_SET: ReadonlySet<string> = new Set(HELP_TOPICS);

export const isHelpTopic = (token: string): token is HelpTopic => HELP_TOPIC_SET.has(token);

export const COMMON_COMMAND_IDS = [
  "app:start",
  "app:stop",
  "app:restart",
  "app:rebuild",
  "app:destroy",
  "app:info",
  "app:logs",
  "app:exec",
  "app:ssh",
  "apps:init",
  "apps:list",
  "meta:setup",
  "meta:doctor",
] as const;

const COMMON_ID_SET: ReadonlySet<string> = new Set(COMMON_COMMAND_IDS);

const AUTHORING_ORDER = [
  "meta:plugin:new",
  "meta:plugin:test",
  "meta:plugin:build",
  "meta:plugin:link",
  "meta:plugin:unlink",
  "meta:plugin:publish",
  "meta:plugin:trust-authoring-root",
] as const;

const AUTHORING_IDS: ReadonlySet<string> = new Set(AUTHORING_ORDER);
const AUTHORING_RANK = new Map<string, number>(AUTHORING_ORDER.map((id, index) => [id, index]));

export { MORE_ROWS } from "./root-help-topics";

type ManifestCommand =
  (typeof COMMAND_REGISTRY_MANIFEST.commands)[keyof typeof COMMAND_REGISTRY_MANIFEST.commands];

type StyleFns = {
  readonly bold: (text: string) => string;
  readonly cyan: (text: string) => string;
  readonly dim: (text: string) => string;
};

const passthrough = (text: string): string => text;

const assertNever = (value: never): never => {
  throw new Error(`Unexpected help topic: ${String(value)}`);
};

const resolveStyle = (options?: ColdHelpStyle): StyleFns => {
  const styled =
    options?.style ??
    shouldStyleHelp({
      isTTY: process.stdout.isTTY === true,
      env: process.env,
      argv: process.argv.slice(2),
      rendererMode: undefined,
    });
  return styled
    ? { bold: wrapBold, cyan: wrapCyan, dim: wrapDim }
    : { bold: passthrough, cyan: passthrough, dim: passthrough };
};

const isHidden = (entry: ManifestCommand): boolean => entry.hidden;
const isDeferred = (entry: ManifestCommand): boolean =>
  "deferred" in entry.spec && entry.spec.deferred !== undefined;
const isCommon = (entry: ManifestCommand): boolean => COMMON_ID_SET.has(entry.spec.id);

const toRow = (entry: ManifestCommand, aliasPolicy?: HelpAliasPolicy): ThisAppHelpRow => {
  const name = typeableName({
    canonicalId: entry.spec.id,
    builtInAliases: entry.aliases,
    implicitNamespaceStrip: false,
    ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
  });
  return {
    canonicalId: entry.spec.id,
    primary: name.primary,
    extras: name.extras,
    summary: entry.spec.summary,
  };
};

const catalogEntries = (): readonly ManifestCommand[] => Object.values(COMMAND_REGISTRY_MANIFEST.commands);

const visibleEntries = (): readonly ManifestCommand[] => catalogEntries().filter((entry) => !isHidden(entry));

export const visibleHelpRows = (aliasPolicy?: HelpAliasPolicy): readonly ThisAppHelpRow[] =>
  visibleEntries().map((entry) => toRow(entry, aliasPolicy));

const padWidth = (names: readonly string[]): number => Math.max(14, ...names.map((name) => name.length));

const formatExtras = (extras: ReadonlyArray<string>, style: StyleFns): string =>
  extras.length === 0 ? "" : ` ${style.dim(`(${extras.join(", ")})`)}`;

const formatRow = (row: ThisAppHelpRow, width: number, style: StyleFns): string =>
  `  ${style.cyan(row.primary.padEnd(width))} ${row.summary}${formatExtras(row.extras, style)}`;

const formatSection = (rows: readonly ThisAppHelpRow[], style: StyleFns): readonly string[] => {
  const width = padWidth(rows.map((row) => row.primary));
  return rows.map((row) => formatRow(row, width, style));
};

const titleLine = (style: StyleFns): string =>
  style.bold(`Lando  ${CORE_VERSION}  ${process.platform}-${process.arch}`);

const usageBlock = (usage: string, style: StyleFns): readonly string[] => [
  style.bold("USAGE"),
  `  ${style.cyan(usage)}`,
];

const byPrimary = (left: ThisAppHelpRow, right: ThisAppHelpRow): number =>
  left.primary.localeCompare(right.primary) || left.canonicalId.localeCompare(right.canonicalId);

export const commonRows = (aliasPolicy?: HelpAliasPolicy): readonly ThisAppHelpRow[] => {
  const byId = new Map(visibleEntries().map((entry) => [entry.spec.id, entry] as const));
  return COMMON_COMMAND_IDS.flatMap((id) => {
    const entry = byId.get(id);
    return entry === undefined ? [] : [toRow(entry, aliasPolicy)];
  });
};

const topicEntries = (topic: HelpTopic): readonly ManifestCommand[] => {
  const entries = visibleEntries().filter((entry) => !isDeferred(entry));
  switch (topic) {
    case "app":
      return entries.filter((entry) => entry.spec.id.startsWith("app:") && !isCommon(entry));
    case "apps":
      return entries.filter(
        (entry) =>
          entry.spec.id.startsWith("apps:") && entry.spec.id !== "apps:init" && entry.spec.id !== "apps:list",
      );
    case "plugin":
      return entries.filter(
        (entry) => entry.spec.id.startsWith("meta:plugin:") && !AUTHORING_IDS.has(entry.spec.id),
      );
    case "global":
      return entries.filter((entry) => entry.spec.id.startsWith("meta:global:"));
    case "recipes":
      return entries.filter((entry) => entry.spec.id.startsWith("meta:recipes:"));
    case "scratch":
      return entries.filter((entry) => entry.spec.id.startsWith("apps:scratch:"));
    default:
      return assertNever(topic);
  }
};

const authoringRows = (aliasPolicy?: HelpAliasPolicy): readonly ThisAppHelpRow[] =>
  visibleEntries()
    .filter((entry) => AUTHORING_IDS.has(entry.spec.id) && !isDeferred(entry))
    .map((entry) => toRow(entry, aliasPolicy))
    .toSorted((left, right) => {
      const leftRank = AUTHORING_RANK.get(left.canonicalId) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = AUTHORING_RANK.get(right.canonicalId) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    });

export const renderColdRootHelp = (
  _activeAliases?: ReadonlyArray<readonly [string, string]>,
  options?: ColdHelpStyle,
): string => {
  const style = resolveStyle(options);
  const rows = moreRows(options?.pluginTopics);
  const moreWidth = padWidth(rows.map((row) => row.token));
  const moreLines = rows.map((row) => {
    const token = `  ${style.cyan(row.token.padEnd(moreWidth))}`;
    return row.summary.length === 0 ? token : `${token} ${row.summary}`;
  });
  const thisAppRows = options?.thisAppRows ?? [];
  const thisAppBlock =
    thisAppRows.length === 0 ? [] : ["", style.bold("THIS APP"), ...formatSection(thisAppRows, style)];
  return [
    titleLine(style),
    "",
    ...usageBlock("lando <command> [flags]", style),
    "",
    style.bold("COMMON"),
    ...formatSection(commonRows(options?.aliasPolicy), style),
    ...thisAppBlock,
    ...toolingMetadataNotice(options?.toolingMetadata),
    "",
    style.bold("MORE"),
    ...moreLines,
  ].join("\n");
};

const topicPageLines = (
  topic: string,
  description: string,
  rows: readonly ThisAppHelpRow[],
  style: StyleFns,
): string[] => [
  titleLine(style),
  "",
  ...usageBlock(`lando help ${topic}`, style),
  "",
  style.bold(topic.toUpperCase()),
  description,
  ...formatSection(rows.toSorted(byPrimary), style),
];

export const renderPluginTopicHelp = (
  topic: string,
  description: string,
  rows: readonly ThisAppHelpRow[],
  options?: ColdHelpStyle,
): string => topicPageLines(topic, description, rows, resolveStyle(options)).join("\n");

export const renderColdTopicHelp = (topic: string, options?: ColdHelpStyle): string => {
  if (!isHelpTopic(topic)) return "";
  const style = resolveStyle(options);
  const rows = topicEntries(topic).map((entry) => toRow(entry, options?.aliasPolicy));
  const lines = topicPageLines(topic, COMMAND_TOPICS[topic].description, rows, style);
  if (topic === "plugin") {
    lines.push("", style.bold("AUTHORING"), ...formatSection(authoringRows(options?.aliasPolicy), style));
  }
  return lines.join("\n");
};

export const renderColdAllHelp = (options?: ColdHelpStyle): string => {
  const style = resolveStyle(options);
  const rows = [...visibleHelpRows(options?.aliasPolicy), ...(options?.pluginRows ?? [])].toSorted(byPrimary);
  const thisAppRows = options?.thisAppRows ?? [];
  return [
    titleLine(style),
    "",
    ...usageBlock("lando help --all", style),
    "",
    style.bold("ALL"),
    ...formatSection(rows, style),
    ...(thisAppRows.length === 0 ? [] : ["", style.bold("THIS APP"), ...formatSection(thisAppRows, style)]),
    ...toolingMetadataNotice(options?.toolingMetadata),
    ...(options?.pluginNotice === undefined ? [] : [options.pluginNotice]),
  ].join("\n");
};

export const renderColdRecipesList = (): string => renderRecipeCatalog(getRecipeCatalog());
