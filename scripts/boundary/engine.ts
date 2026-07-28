import { isAbsolute, relative, resolve } from "node:path";

import ts from "typescript";

import { BOUNDARY_RULES } from "./registry.ts";
import { fileMatchesScope, walkFiles } from "./scope.ts";
import { SourceCache, type SourceCacheCounters } from "./source-cache.ts";
import type {
  BoundaryRule,
  BoundaryRuleResult,
  FileContext,
  FileRecord,
  ProgramContext,
  Violation,
} from "./types.ts";

let lastRunCacheStats: SourceCacheCounters = { parseCount: 0, cacheHitCount: 0 };

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const isCarvedOut = (file: FileRecord, rule: BoundaryRule): boolean =>
  rule.carveOuts.files.includes(file.relativePath) ||
  rule.carveOuts.prefixes.some((prefix) => file.relativePath.startsWith(prefix));

const selectedFiles = (files: readonly FileRecord[], rule: BoundaryRule): readonly FileRecord[] =>
  files.filter((file) => fileMatchesScope(file.relativePath, rule.scope) && !isCarvedOut(file, rule));

const sortViolations = (violations: readonly Violation[]): readonly Violation[] =>
  violations.slice().sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

const resolveContextFile = (
  root: string,
  files: readonly FileRecord[],
  input: FileRecord | string,
): FileRecord => {
  if (typeof input !== "string") return input;
  const relativePath = normalizePath(isAbsolute(input) ? relative(root, input) : input);
  const file = files.find((candidate) => candidate.relativePath === relativePath);
  if (file === undefined) throw new TypeError(`File is outside this rule's program scope: ${input}`);
  return file;
};

const fileContext = (
  file: FileRecord,
  cache: SourceCache,
  report: (violation: Violation) => void,
): FileContext => ({
  ...file,
  get sourceFile() {
    return cache.sourceFile(file);
  },
  report: ({ line, detail }) => report({ file: file.relativePath, line, detail }),
});

const programContext = (
  root: string,
  files: readonly FileRecord[],
  cache: SourceCache,
  report: (violation: Violation) => void,
): ProgramContext => ({
  root,
  files,
  sourceFile: (file) => cache.sourceFile(resolveContextFile(root, files, file)),
  text: (file) => cache.text(resolveContextFile(root, files, file)),
  edges: (file) => cache.moduleEdges(resolveContextFile(root, files, file)),
  report: (file, line, detail) => {
    const relativePath = normalizePath(isAbsolute(file) ? relative(root, file) : file);
    report({ file: relativePath, line, detail });
  },
});

export const getLastRunCacheStats = (): SourceCacheCounters => lastRunCacheStats;

export const runRuleSet = async (
  rules: readonly BoundaryRule[],
  rootInput: string,
): Promise<ReadonlyMap<string, BoundaryRuleResult>> => {
  const root = resolve(rootInput);
  const cache = new SourceCache();
  lastRunCacheStats = cache.counters();
  const files = await walkFiles(
    root,
    rules.map((rule) => rule.scope),
  );
  const violations = new Map(rules.map((rule) => [rule.id, [] as Violation[]]));
  const filesByRule = new Map(rules.map((rule) => [rule.id, selectedFiles(files, rule)]));
  const reportFor =
    (rule: BoundaryRule) =>
    (violation: Violation): void => {
      violations.get(rule.id)?.push(violation);
    };

  for (const file of files) {
    const nodeRules = rules.filter(
      (rule) => rule.onNode !== undefined && filesByRule.get(rule.id)?.includes(file),
    );
    if (nodeRules.length > 0) {
      const source = await cache.sourceFile(file);
      const contexts = new Map(nodeRules.map((rule) => [rule.id, fileContext(file, cache, reportFor(rule))]));
      const visit = (node: ts.Node): void => {
        for (const rule of nodeRules) {
          const context = contexts.get(rule.id);
          if (context !== undefined) rule.onNode?.(node, context);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    for (const rule of rules) {
      if (rule.onEdges === undefined || !filesByRule.get(rule.id)?.includes(file)) continue;
      await Promise.resolve(
        rule.onEdges(await cache.moduleEdges(file), fileContext(file, cache, reportFor(rule))),
      );
    }
  }

  for (const rule of rules) {
    if (rule.onProgram === undefined) continue;
    const ruleFiles = filesByRule.get(rule.id) ?? [];
    await Promise.resolve(rule.onProgram(programContext(root, ruleFiles, cache, reportFor(rule))));
  }

  lastRunCacheStats = cache.counters();
  return new Map(
    rules.map((rule) => {
      const sorted = sortViolations(violations.get(rule.id) ?? []);
      return [rule.id, { ok: sorted.length === 0, violations: sorted }];
    }),
  );
};

export const runRules = async (
  ruleIds: readonly string[],
  root: string,
): Promise<ReadonlyMap<string, BoundaryRuleResult>> => {
  const rules = ruleIds.map((id) => {
    const rule = BOUNDARY_RULES.get(id);
    if (rule === undefined) throw new TypeError(`Unknown boundary rule: ${id}`);
    return rule;
  });
  return runRuleSet(rules, root);
};
