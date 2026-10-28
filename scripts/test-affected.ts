#!/usr/bin/env bun
import { existsSync } from "node:fs";
/**
 * Local, source-based unit-test selection. This is a review aid; CI still runs
 * its complete selected shards. Paths and witnesses are repository-relative.
 */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

import { loadWorkspacePackages, resolveFile, resolveWorkspaceSpecifier } from "./boundary/graph.ts";
import { scanLiterals } from "./boundary/literals.ts";
import { scanModuleEdgesFromSource } from "./module-edge-scan.ts";
import { collectShardedTestFiles } from "./test-shards.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/u;
const CONFIG = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|bunfig\.toml|bun\.lock|\.bun-version)$/u;
const norm = (value: string): string => value.replaceAll("\\", "/");
const sorted = <T>(values: Iterable<T>): T[] => [...values].sort() as T[];

const git = async (
  root: string,
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> => {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
};

const requireGit = async (root: string, args: readonly string[]): Promise<string> => {
  const result = await git(root, args);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.err.trim()}`);
  return result.out;
};

const relativePath = (root: string, input: string): string => {
  const absolute = resolve(root, input);
  const path = norm(relative(root, absolute));
  if (path === ".." || path.startsWith("../") || isAbsolute(path) || path === "") {
    throw new Error(`path must be a file inside the repository: ${input}`);
  }
  return path;
};

const baseCommit = async (root: string, baseRef: string): Promise<string> =>
  (await requireGit(root, ["merge-base", "HEAD", baseRef])).trim();

export const changedPaths = async (root: string, baseRef: string): Promise<readonly string[]> => {
  const base = await baseCommit(root, baseRef);
  const diff = await requireGit(root, ["diff", "--name-status", "-z", "--find-renames", base, "--"]);
  const fields = diff.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index++] ?? "";
    const oldPath = fields[index++];
    if (oldPath === undefined) throw new Error("malformed git name-status output");
    paths.add(oldPath);
    if (status.startsWith("R") || status.startsWith("C")) {
      const newPath = fields[index++];
      if (newPath === undefined) throw new Error("malformed git rename output");
      paths.add(newPath);
    }
  }
  const untracked = await requireGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const path of untracked.split("\0")) if (path) paths.add(path);
  return sorted([...paths].map((path) => relativePath(root, path)));
};

const sourceFiles = async (root: string): Promise<Set<string>> => {
  const files = new Set<string>();
  // Git supplies source files in any package directory, including bin/ and
  // package-local tooling. The globs below also include ignored generated
  // modules that exist on disk after codegen.
  const listed = await requireGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  for (const path of listed.split("\0")) {
    if (path && SOURCE.test(path)) files.add(resolve(root, path));
  }
  const packages = await loadWorkspacePackages(root);
  const directories = new Set([...packages.values()].map((entry) => entry.directory));
  directories.add(resolve(root, "scripts"));
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const pattern of [
      "src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "test/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
    ]) {
      // The broad pattern is needed for root scripts and package-local entry files.
      if (pattern.startsWith("**/") && directory !== resolve(root, "scripts")) continue;
      for await (const path of new Bun.Glob(pattern).scan({ cwd: directory, onlyFiles: true })) {
        files.add(resolve(directory, path));
      }
    }
  }
  return files;
};

const parseSource = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const literalDynamic = (source: ts.SourceFile): readonly number[] => {
  const uncertain: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] !== undefined &&
      !ts.isStringLiteral(node.arguments[0]) &&
      !ts.isNoSubstitutionTemplateLiteral(node.arguments[0])
    ) {
      uncertain.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uncertain;
};

const fixtureApp = (path: string): string | undefined => {
  const match = /^(.+?\/fixtures\/[^/]+|recipes\/[^/]+)(?:\/|$)/u.exec(path);
  return match?.[1];
};

const referenceMatches = (literal: string, changed: string, source: string, root: string): boolean => {
  if (!literal || literal.includes("://")) return false;
  const value = norm(literal);
  const candidates = new Set<string>();
  if (value.startsWith("./") || value.startsWith("../")) {
    candidates.add(norm(relative(root, resolve(dirname(source), value))));
  }
  if (value === "fixtures" || value.startsWith("fixtures/")) {
    candidates.add(norm(relative(root, resolve(dirname(source), value))));
  }
  if (value.startsWith("docs/") || value.startsWith("recipes/") || value.startsWith("landofile/")) {
    candidates.add(value);
  }
  const app = fixtureApp(changed);
  if (app) {
    for (const candidate of [...candidates]) {
      // A fixture reader may glob only its .lando file but consume sibling
      // include files from the same app directory.
      for (const name of [".lando.yml", ".lando.ts", ".lando.base.yml", ".lando.local.yml"]) {
        if (new Bun.Glob(candidate).match(`${app}/${name}`)) return true;
      }
      if (candidate.endsWith("/fixtures") && app.startsWith(`${candidate}/`)) return true;
      if (candidate.includes("/fixtures/") && candidate === app) return true;
    }
  }
  return [...candidates].some((candidate) => {
    if (candidate === changed) return true;
    return candidate.includes("*") && new Bun.Glob(candidate).match(changed);
  });
};

export interface Selection {
  readonly changed: readonly string[];
  readonly eligibleCount: number;
  readonly selected: readonly string[];
  readonly witnesses: ReadonlyMap<string, readonly string[]>;
  readonly fixtureTests: readonly string[];
  readonly priorTests: readonly string[];
  readonly unmatched: readonly string[];
  readonly uncertain: readonly string[];
  readonly broadReason?: string;
}

export const selectAffectedTests = async (options: {
  readonly root?: string;
  readonly changed: readonly string[];
  readonly eligible?: readonly string[];
  readonly baseRef?: string;
}): Promise<Selection> => {
  const root = resolve(options.root ?? ROOT);
  const changed = sorted(new Set(options.changed.map((path) => relativePath(root, path))));
  const eligible = sorted(options.eligible ?? (await collectShardedTestFiles()));
  const broadReason = changed.some((path) => CONFIG.test(path))
    ? "configuration or workspace mapping changed"
    : undefined;
  const files = await sourceFiles(root);
  for (const path of changed) if (SOURCE.test(path)) files.add(resolve(root, path));
  const packages = await loadWorkspacePackages(root);
  const reverse = new Map<string, Set<string>>();
  const parsed = new Map<string, ts.SourceFile>();
  const priorEdges = new Set<string>();
  const uncertain = new Set<string>();
  const addEdge = (from: string, to: string): void => {
    const incoming = reverse.get(to) ?? new Set<string>();
    incoming.add(from);
    reverse.set(to, incoming);
  };
  const scan = (file: string, sourceText: string, prior = false): readonly string[] => {
    const source = parseSource(file, sourceText);
    if (!prior) parsed.set(file, source);
    const targets: string[] = [];
    for (const line of literalDynamic(source))
      uncertain.add(`${norm(relative(root, file))}:${line}: computed import/require`);
    for (const edge of scanModuleEdgesFromSource(source)) {
      const specifier = edge.specifier;
      const targetBase = specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : resolveWorkspaceSpecifier(specifier, packages);
      if (!targetBase) {
        if (
          specifier.startsWith("@lando/") ||
          [...packages.keys()].some((name) => specifier === name || specifier.startsWith(`${name}/`))
        ) {
          uncertain.add(
            `${norm(relative(root, file))}:${edge.line}: unresolved workspace export ${specifier}`,
          );
        }
        continue;
      }
      const target = resolveFile(targetBase, files);
      if (target) {
        addEdge(file, target);
        if (prior) priorEdges.add(`${file}\0${target}`);
        targets.push(target);
      } else
        uncertain.add(`${norm(relative(root, file))}:${edge.line}: unresolved local module ${specifier}`);
    }
    return targets;
  };
  const pending = eligible.map((path) => resolve(root, path));
  const scanned = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const file = pending[index];
    if (!file || scanned.has(file) || !files.has(file)) continue;
    scanned.add(file);
    const blob = Bun.file(file);
    if (await blob.exists()) pending.push(...scan(file, await blob.text()));
  }
  if (options.baseRef) {
    uncertain.add(
      "history: prior edges reconstructed only for supplied changed source paths; omitted rewritten importers may hide dependencies",
    );
    const base = await baseCommit(root, options.baseRef);
    for (const path of changed.filter((path) => SOURCE.test(path))) {
      const result = await git(root, ["show", `${base}:${path}`]);
      if (result.code === 0) scan(resolve(root, path), result.out, true);
    }
  }

  const witnesses = new Map<string, readonly string[]>();
  const fixtureSources = new Map<string, string[]>();
  for (const [file, source] of parsed) {
    const literals = scanLiterals(source);
    for (const path of changed) {
      if (SOURCE.test(path) && !fixtureApp(path)) continue;
      if (!literals.some((literal) => referenceMatches(literal.value, path, file, root))) continue;
      const sources = fixtureSources.get(path) ?? [];
      sources.push(file);
      fixtureSources.set(path, sources);
    }
  }
  const matched = new Set<string>();
  const fixtureTests = new Set<string>();
  const priorTests = new Set<string>();
  const eligibleSet = new Set(eligible);
  for (const changedPath of changed) {
    const rootPath = resolve(root, changedPath);
    const queue: string[][] = [
      [rootPath],
      ...(fixtureSources.get(changedPath) ?? []).map((file) => [rootPath, file]),
    ];
    const reached = new Set<string>();
    for (let head = 0; head < queue.length; head++) {
      const witness = queue[head];
      if (!witness) continue;
      const node = witness[witness.length - 1];
      if (!node || reached.has(node)) continue;
      reached.add(node);
      const path = norm(relative(root, node));
      if (eligibleSet.has(path)) {
        matched.add(changedPath);
        if (!witnesses.has(path)) {
          witnesses.set(
            path,
            witness.map((entry) => norm(relative(root, entry))),
          );
          if (witness.length > 1 && fixtureSources.get(changedPath)?.includes(witness[1] ?? "")) {
            fixtureTests.add(path);
          }
          if (
            witness.some((entry, index) => index > 0 && priorEdges.has(`${entry}\0${witness[index - 1]}`))
          ) {
            priorTests.add(path);
          }
        }
      }
      for (const importer of sorted(reverse.get(node) ?? [])) queue.push([...witness, importer]);
    }
  }
  if (broadReason) {
    for (const test of eligible) witnesses.set(test, [changed.find((path) => CONFIG.test(path)) ?? "", test]);
    fixtureTests.clear();
    priorTests.clear();
  }
  const unmatched = broadReason ? [] : changed.filter((path) => !matched.has(path));
  return {
    changed,
    eligibleCount: eligible.length,
    selected: sorted(witnesses.keys()),
    witnesses,
    fixtureTests: sorted(fixtureTests),
    priorTests: sorted(priorTests),
    unmatched,
    uncertain: sorted(uncertain),
    ...(broadReason ? { broadReason } : {}),
  };
};

const parseArgs = (args: readonly string[]): { base: string; files: string[]; run: boolean } => {
  let base = "origin/main";
  const files: string[] = [];
  let run = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--run") run = true;
    else if (arg === "--base" || arg === "--file") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--base") base = value;
      else files.push(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { base, files, run };
};

export const affectedTestCommand = (selected: readonly string[]): readonly string[] => [
  process.execPath,
  "--no-orphans",
  "test",
  "--timeout=20000",
  ...selected.map((path) => `./${path}`),
];

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const changed = args.files.length ? args.files : await changedPaths(ROOT, args.base);
  const result = await selectAffectedTests({ changed, baseRef: args.base });
  console.log(
    `[test-affected] base=${args.base}${args.files.length ? " (explicit paths)" : " (merge-base diff plus untracked)"}`,
  );
  console.log(
    `[test-affected] changed=${result.changed.length} eligible=${result.eligibleCount} selected=${result.selected.length}`,
  );
  console.log("[test-affected] coverage is static/heuristic and partial; CI runs full selected shards.");
  if (result.broadReason) console.log(`[test-affected] broad selection: ${result.broadReason}`);
  for (const test of result.selected) {
    const label = result.fixtureTests.includes(test) ? " (fixture reference heuristic)" : "";
    const prior = result.priorTests.includes(test) ? " (includes base edge)" : "";
    console.log(`  ${test}${label}${prior}: ${result.witnesses.get(test)?.join(" -> ")}`);
  }
  console.log(`[test-affected] unmatched changed paths=${result.unmatched.length}`);
  for (const path of result.unmatched) console.log(`  unmatched: ${path}`);
  console.log(`[test-affected] uncertain references=${result.uncertain.length}`);
  for (const path of result.uncertain) console.log(`  uncertain: ${path}`);
  if (!args.run) return;
  if (result.selected.length === 0)
    throw new Error("--run selected zero test files; no test process started");
  const child = Bun.spawn([...affectedTestCommand(result.selected)], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const cancel = (): void => child.kill();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const code = await child.exited;
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  process.exitCode = code;
};

if (import.meta.main) await main();
