#!/usr/bin/env bun
import { resolve } from "node:path";

import {
  type ComposeDisposition,
  type ComposeDispositionEntry,
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "../landofile/src/compose/dispositions.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "docs/reference/compose-key-matrix.mdx");

type DispositionMap = Readonly<Record<string, ComposeDispositionEntry>>;
type DispositionRow = readonly [path: string, entry: ComposeDispositionEntry];
type PlanScope = "service" | "top-level";

interface MatrixSources {
  readonly service: DispositionMap;
  readonly topLevel: DispositionMap;
  readonly tags: DispositionMap;
}

interface ServiceGroup {
  readonly root: DispositionRow;
  readonly descendants: ReadonlyArray<DispositionRow>;
}

const DEFAULT_SOURCES = {
  service: composeServiceDispositions,
  topLevel: composeTopLevelDispositions,
  tags: composeTagDispositions,
} as const satisfies MatrixSources;

class ComposeKeyMatrixError extends Error {
  override readonly name = "ComposeKeyMatrixError";
}

const failInvariant = (message: string): never => {
  throw new ComposeKeyMatrixError(message);
};

const assertNever = (value: never): never =>
  failInvariant(`Unexpected Compose disposition: ${String(value)}`);

const escapeCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

const sortedEntries = (entries: DispositionMap): ReadonlyArray<DispositionRow> =>
  Object.entries(entries).sort(([left], [right]) => left.localeCompare(right));

const detailFor = (entry: ComposeDispositionEntry, scope: PlanScope): string => {
  switch (entry.disposition) {
    case "normalized": {
      if (entry.planTarget === undefined || entry.planTarget.length === 0) return entry.rationale;
      const plan = scope === "top-level" ? "AppPlan" : "ServicePlan";
      return `Normalizes into ${entry.planTarget.map((target) => `\`${plan}.${target}\``).join(", ")}`;
    }
    case "preserved":
      return entry.rationale;
    case "rejected":
      return entry.remediation ?? "";
    default:
      return assertNever(entry.disposition);
  }
};

const renderDetailRow = ([path, entry]: DispositionRow, scope: PlanScope): string =>
  `| \`${escapeCell(path)}\` | ${escapeCell(entry.disposition)} | ${escapeCell(detailFor(entry, scope))} |`;

const renderDetailTable = (rows: ReadonlyArray<DispositionRow>, scope: PlanScope): string =>
  [
    "| Key path | Disposition | Detail |",
    "| --- | --- | --- |",
    ...rows.map((row) => renderDetailRow(row, scope)),
  ].join("\n");

const serviceGroups = (entries: DispositionMap): ReadonlyArray<ServiceGroup> => {
  const rows = sortedEntries(entries);
  return rows
    .filter(([path]) => !path.includes("."))
    .map((root) => ({
      root,
      descendants: rows.filter(([path]) => path.startsWith(`${root[0]}.`)),
    }));
};

const countDisposition = (entries: DispositionMap, disposition: ComposeDisposition): number =>
  Object.values(entries).filter((entry) => entry.disposition === disposition).length;

const renderSummaryRow = (label: string, entries: DispositionMap): string =>
  `| ${escapeCell(label)} | ${countDisposition(entries, "normalized")} | ${countDisposition(entries, "preserved")} | ${countDisposition(entries, "rejected")} | ${Object.keys(entries).length} |`;

const renderCoverageSummary = (sources: MatrixSources): string =>
  [
    "| Scope | Normalized | Preserved | Rejected | Total |",
    "| --- | --- | --- | --- | --- |",
    renderSummaryRow("Top-level keys", sources.topLevel),
    renderSummaryRow("Service keys", sources.service),
    renderSummaryRow("YAML tags", sources.tags),
  ].join("\n");

const rootAnchor = (root: string): string =>
  root
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");

const renderServiceRoots = (groups: ReadonlyArray<ServiceGroup>): string =>
  [
    "| Key | Disposition | Nested paths | Detail |",
    "| --- | --- | --- | --- |",
    ...groups.map(({ root: [path, entry], descendants }) => {
      const key =
        descendants.length === 0
          ? `\`${escapeCell(path)}\``
          : `[\`${escapeCell(path)}\`](#${rootAnchor(path)})`;
      const nestedPaths = descendants.length === 0 ? "—" : String(descendants.length);
      return `| ${key} | ${escapeCell(entry.disposition)} | ${nestedPaths} | ${escapeCell(detailFor(entry, "service"))} |`;
    }),
  ].join("\n");

const renderServiceSections = (groups: ReadonlyArray<ServiceGroup>): string =>
  groups
    .filter(({ descendants }) => descendants.length > 0)
    .map(
      ({ root, descendants }) =>
        `### \`${escapeCell(root[0])}\`\n\n${renderDetailTable([root, ...descendants], "service")}`,
    )
    .join("\n\n");

const assertMatrixInvariants = (sources: MatrixSources = DEFAULT_SOURCES): void => {
  const matrices = [
    ["service", sources.service],
    ["topLevel", sources.topLevel],
    ["tags", sources.tags],
  ] as const satisfies ReadonlyArray<readonly [string, DispositionMap]>;
  for (const [scope, entries] of matrices) {
    for (const [path, entry] of Object.entries(entries)) {
      if (entry.rationale.trim().length === 0) {
        failInvariant(`${scope} disposition ${path} must include a rationale`);
      }
      if (entry.disposition === "rejected" && (entry.remediation?.trim().length ?? 0) === 0) {
        failInvariant(`${scope} rejected disposition ${path} must include remediation`);
      }
    }
  }

  for (const [path, entry] of Object.entries(sources.service)) {
    if (
      entry.disposition === "normalized" &&
      (entry.planTarget === undefined || entry.planTarget.length === 0)
    ) {
      failInvariant(`Normalized service disposition ${path} must include a planTarget`);
    }
  }

  // Grouping is the only render path that can drop a row: a descendant whose root key is absent
  // never reaches a section. Flat scopes map one row per entry by construction.
  const emittedCount = serviceGroups(sources.service).reduce(
    (count, group) => count + 1 + group.descendants.length,
    0,
  );
  const sourceCount = Object.keys(sources.service).length;
  if (emittedCount !== sourceCount) {
    failInvariant(`Service matrix emitted ${emittedCount} rows for ${sourceCount} disposition entries`);
  }
};

const renderComposeKeyMatrixPage = (): string => {
  assertMatrixInvariants();
  const groups = serviceGroups(DEFAULT_SOURCES.service);
  const sections = [
    "---",
    "title: Compose Key Matrix",
    "description: Generated disposition matrix for every upstream Compose key path Lando classifies.",
    "---",
    "",
    "{/* GENERATED FILE — do not hand-edit. Regenerate via `bun run codegen:compose-key-matrix`. */}",
    "",
    "# Compose Key Matrix",
    "",
    "A `normalized` key resolves into a provider-neutral plan field. A `preserved` key is accepted and carried in the Compose plan extension; row details determine capability behavior. A `rejected` key fails closed with a tagged error and remediation.",
    "",
    "See [Compose service blocks](../guides/config/compose-service-block.mdx) and [Compose compatibility](../guides/config/compose-compatibility.mdx) for usage guidance.",
    "",
    "## Coverage summary",
    "",
    renderCoverageSummary(DEFAULT_SOURCES),
    "",
    "## Top-level keys",
    "",
    renderDetailTable(sortedEntries(DEFAULT_SOURCES.topLevel), "top-level"),
    "",
    "## YAML tags",
    "",
    renderDetailTable(sortedEntries(DEFAULT_SOURCES.tags), "top-level"),
    "",
    "## Service keys",
    "",
    "### Key roots",
    "",
    renderServiceRoots(groups),
    "",
    renderServiceSections(groups),
  ];
  return `${sections.join("\n").trimEnd()}\n`;
};

const main = async (): Promise<void> => {
  await Bun.write(OUTPUT, renderComposeKeyMatrixPage());
  console.log(`[build-compose-key-matrix] wrote ${OUTPUT}`);
};

if (import.meta.main) await main();

export { ComposeKeyMatrixError, renderComposeKeyMatrixPage, assertMatrixInvariants };
