import { CORE_VERSION } from "@lando/engine/version";
import { getRecipeCatalog } from "../recipes/catalog";
import { renderRecipeCatalog } from "../recipes/catalog-render";
import { COMMAND_TOPICS } from "./command-topics";
import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest";
import { type HelpAliasPolicy, typeableName } from "./help-names";
import { shouldStyleHelp, bold as wrapBold, cyan as wrapCyan, dim as wrapDim } from "./help-style";

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

export const MORE_ROWS = [
  { token: "lando help app", summary: "Config, remotes, share, includes" },
  { token: "lando help apps", summary: "Poweroff and scratch apps" },
  { token: "lando help plugin", summary: "Install and author plugins" },
  { token: "lando help global", summary: "Host-level global app" },
  { token: "lando help recipes", summary: "Bundled recipes" },
  { token: "lando help --all", summary: "Every command and alias" },
  { token: "lando <command> --help", summary: "" },
] as const;

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
  const moreWidth = padWidth(MORE_ROWS.map((row) => row.token));
  const moreLines = MORE_ROWS.map((row) => {
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
    "",
    style.bold("MORE"),
    ...moreLines,
  ].join("\n");
};

export const renderColdTopicHelp = (topic: string, options?: ColdHelpStyle): string => {
  if (!isHelpTopic(topic)) return "";
  const style = resolveStyle(options);
  const rows = topicEntries(topic)
    .map((entry) => toRow(entry, options?.aliasPolicy))
    .toSorted(byPrimary);
  const lines = [
    titleLine(style),
    "",
    ...usageBlock(`lando help ${topic}`, style),
    "",
    style.bold(topic.toUpperCase()),
    COMMAND_TOPICS[topic].description,
    ...formatSection(rows, style),
  ];
  if (topic === "plugin") {
    lines.push("", style.bold("AUTHORING"), ...formatSection(authoringRows(options?.aliasPolicy), style));
  }
  return lines.join("\n");
};

export const renderColdAllHelp = (options?: ColdHelpStyle): string => {
  const style = resolveStyle(options);
  const rows = visibleHelpRows(options?.aliasPolicy).toSorted(byPrimary);
  return [
    titleLine(style),
    "",
    ...usageBlock("lando help --all", style),
    "",
    style.bold("ALL"),
    ...formatSection(rows, style),
  ].join("\n");
};

export const renderColdRecipesList = (): string => renderRecipeCatalog(getRecipeCatalog());
