import { COMMAND_REGISTRY_MANIFEST } from "../../core/src/cli/generated/command-registry-manifest.ts";
import { guideProseCommandArgvs } from "../../core/src/docs/guide-compiler/command-argv.ts";
import {
  CONTAINER_COMMAND_CODE as CODE,
  CONTAINER_COMMAND_BASELINE_PATH,
  type ContainerCommandBaseline,
  CONTAINER_COMMAND_WAIVER as WAIVER,
} from "./container-command-baseline.ts";
import { type CoverageLintDocument, e2eCommandArgvs } from "./coverage-lint-input.ts";
import { type GuideLintDiagnostic, diagnostic } from "./lint-diagnostic.ts";
import type { MdxNode } from "./mdx.ts";

const builtinIds = new Map<string, string>();
for (const [id, command] of Object.entries(COMMAND_REGISTRY_MANIFEST.commands)) {
  builtinIds.set(id, id);
  for (const alias of command.aliases) builtinIds.set(alias, id);
}
const containerIds = new Set(["app:exec", "app:ssh", "app:logs"]);
const languages = new Set(["sh", "bash", "shell", "console", "zsh"]);
const illustrative = /(?:^|[=/])<[A-Za-z][A-Za-z0-9_-]*>(?=$|\/)|^\.\.\.$/;
const isContainerCommand = ([program, name, ...args]: readonly string[]) => {
  if (program !== "lando" || name === undefined || name === "help" || name.startsWith("-")) return false;
  const id = builtinIds.get(name);
  return (id === undefined || containerIds.has(id)) && ![name, ...args].some((arg) => illustrative.test(arg));
};

const normalize = (argv: readonly string[]): string =>
  argv
    .map((arg) => (/^[A-Za-z0-9_./:@%+=,^-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(" ");

const fenceCommands = (node: MdxNode): readonly string[] => {
  if (node.type !== "code" || !languages.has(node.lang ?? "") || typeof node.value !== "string") return [];
  if (!/\blando[ \t]/.test(node.value)) return [];
  const source = node.value.replaceAll("\r\n", "\n");
  const lines = node.lang === "console" ? source.replace(/\\\n/g, "").split("\n") : [source];
  return lines
    .flatMap((line) => guideProseCommandArgvs(line.replace(/^[ \t]*\$ /gm, "")))
    .filter(isContainerCommand)
    .map(normalize);
};

const checkWaiver = (doc: CoverageLintDocument, node: MdxNode, next?: MdxNode) => {
  if (
    (node.type !== "mdxFlowExpression" && node.type !== "mdxTextExpression") ||
    typeof node.value !== "string" ||
    !/^\s*\/\*\s*lando-lint\b[^\w\n]*not-e2e\b/.test(node.value)
  )
    return undefined;
  const reason = /^\s*\/\*\s*lando-lint:\s+not-e2e\s+(.*?)\*\/\s*$/s.exec(node.value)?.[1]?.trim();
  if (reason === undefined || reason.includes("*/") || [...reason].length < 8)
    return diagnostic(doc.sourcePath, node, CODE, `Use ${WAIVER} with a reason of at least 8 characters.`);
  const end = node.position?.end?.offset;
  const start = next?.position?.start?.offset;
  if (
    next?.type !== "code" ||
    end === undefined ||
    start === undefined ||
    doc.content.slice(end, start).trim() !== ""
  )
    return diagnostic(doc.sourcePath, node, CODE, `Put ${WAIVER} directly above the shell fence it waives.`);
  return "valid";
};

const inspectPage = (doc: CoverageLintDocument) => {
  const covered = new Set(doc.guide === undefined ? [] : Array.from(e2eCommandArgvs(doc.guide), normalize));
  const uncovered = new Map<string, MdxNode>();
  const diagnostics: GuideLintDiagnostic[] = [];
  const visit = (parent: MdxNode) => {
    if (parent.name === "Guide") return;
    const children = parent.children ?? [];
    let waiver: MdxNode | undefined;
    for (const [index, node] of children.entries()) {
      const commands = fenceCommands(node);
      if (waiver !== undefined) {
        if (commands.length === 0)
          diagnostics.push(
            diagnostic(
              doc.sourcePath,
              waiver,
              CODE,
              "Remove this stale not-e2e waiver: its fence has no in-scope container command.",
            ),
          );
        waiver = undefined;
      } else {
        for (const command of commands)
          if (!covered.has(command) && !uncovered.has(command)) uncovered.set(command, node);
      }
      const status = checkWaiver(doc, node, children[index + 1]);
      if (status === "valid") waiver = node;
      else if (status !== undefined) diagnostics.push(status);
      visit(node);
    }
  };
  visit(doc.root);
  return { diagnostics, uncovered };
};

export const lintContainerCommandCoverage = (
  documents: readonly CoverageLintDocument[],
  baseline: ContainerCommandBaseline,
  options: { readonly fullScan: boolean; readonly unchecked: ReadonlySet<string> },
) => {
  const diagnostics: GuideLintDiagnostic[] = [];
  const stale: GuideLintDiagnostic[] = [];
  const retained = new Map(Object.entries(baseline));
  for (const doc of documents) {
    const page = inspectPage(doc);
    diagnostics.push(...page.diagnostics);
    const entries = retained.get(doc.sourcePath) ?? [];
    const allowed = new Set(entries);
    for (const [command, node] of page.uncovered) {
      if (!allowed.has(command))
        diagnostics.push(
          diagnostic(
            doc.sourcePath,
            node,
            CODE,
            `\`${/[\r\n]/.test(command) ? JSON.stringify(command) : command}\` runs inside a container, but no layer="e2e" scenario on this page runs it. Run this exact argv in an e2e scenario on this page (a <Hidden> step works), or put ${WAIVER} directly above the fence if it cannot run in CI.`,
          ),
        );
    }
    if (options.unchecked.has(doc.sourcePath)) continue;
    const live = entries.filter((command) => {
      if (page.uncovered.has(command)) return true;
      stale.push(staleEntry(doc.sourcePath, command));
      return false;
    });
    if (live.length === 0) retained.delete(doc.sourcePath);
    else retained.set(doc.sourcePath, live);
  }
  if (options.fullScan) {
    const paths = new Set(documents.map((doc) => doc.sourcePath));
    for (const [path, entries] of retained) {
      if (paths.has(path) || options.unchecked.has(path)) continue;
      for (const command of entries) stale.push(staleEntry(path, command));
      retained.delete(path);
    }
  }
  return { diagnostics, stale, retained: Object.fromEntries(retained) };
};

const staleEntry = (sourcePath: string, command: string): GuideLintDiagnostic => ({
  sourcePath,
  line: 1,
  column: 1,
  code: CODE,
  message: `Delete stale entry ${JSON.stringify(command)} under ${JSON.stringify(sourcePath)} in ${CONTAINER_COMMAND_BASELINE_PATH}, or run bun run scripts/lint-guides.ts --prune-container-command-baseline.`,
});
