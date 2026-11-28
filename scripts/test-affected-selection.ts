import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type ts from "@typescript/typescript6";

import { loadWorkspacePackages, resolveFile, resolveWorkspaceSpecifier } from "./boundary/graph.ts";
import { scanLiterals } from "./boundary/literals.ts";
import { readFileAtCommit, resolveMergeBase } from "./git-changes.ts";
import { scanModuleEdgesFromSource } from "./module-edge-scan.ts";
import { modelPreloads } from "./test-affected-preload.ts";
import {
  SOURCE,
  configuredPreloads,
  fixtureApp,
  joinedLiterals,
  literalDynamic,
  norm,
  parseSource,
  referenceMatches,
  relativePath,
  sorted,
  sourceFiles,
} from "./test-affected-sources.ts";
import { collectShardedTestFiles } from "./test-shards.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|bunfig\.toml|bun\.lock|\.bun-version)$/u;

export interface Selection {
  readonly changed: readonly string[];
  readonly eligibleCount: number;
  readonly selected: readonly string[];
  readonly witnesses: ReadonlyMap<string, readonly string[]>;
  readonly fixtureTests: readonly string[];
  readonly priorTests: readonly string[];
  readonly sharedPreloadTests: readonly string[];
  readonly preloadGlobalTests: readonly string[];
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
  const eligible = sorted(options.eligible ?? (await collectShardedTestFiles(root)));
  let broadReason = changed.some((path) => CONFIG.test(path))
    ? "configuration or workspace mapping changed"
    : undefined;
  const files = await sourceFiles(root);
  for (const path of changed) if (SOURCE.test(path)) files.add(resolve(root, path));
  const packages = await loadWorkspacePackages(root);
  const preloads = await configuredPreloads(root, files, packages);
  const reverse = new Map<string, Set<string>>();
  const fixtureSources = new Map<string, string[]>();
  const resourcePaths = changed.filter((path) => !SOURCE.test(path) || fixtureApp(path));
  const priorEdges = new Set<string>();
  const uncertain = new Set<string>();
  if (preloads.error) {
    broadReason = `test preload configuration uncertain: ${preloads.error}`;
    uncertain.add(`test preload configuration: ${preloads.error}`);
  }
  const addEdge = (from: string, to: string): void => {
    const incoming = reverse.get(to) ?? new Set<string>();
    incoming.add(from);
    reverse.set(to, incoming);
  };
  for (const test of eligible) {
    for (const preload of preloads.roots) addEdge(resolve(root, test), preload);
  }
  const sources = new Map<string, ts.SourceFile>();
  const importBase = (file: string, specifier: string): string | undefined =>
    specifier.startsWith(".")
      ? resolve(dirname(file), specifier)
      : resolveWorkspaceSpecifier(specifier, packages);
  const resolveImport = (file: string, specifier: string): string | undefined => {
    const target = importBase(file, specifier);
    return target && resolveFile(target, files);
  };
  const packageDirectories = [...packages.values()].map((entry) => entry.directory);
  // A test-side literal naming a source file means the test may run it in a
  // child process (`bun core/bin/lando.ts`, `bun -e`) or read it, which no
  // import shows. Production code reaches its spawned entries through imports.
  const entryReference = (file: string, value: string): string | undefined => {
    if (!/(?:^|\/)test\//u.test(norm(relative(root, file)))) return undefined;
    if (!SOURCE.test(value) || value.includes("://")) return undefined;
    // A template part such as `${repo}/core/bin/lando.ts` starts with a slash.
    const path = isAbsolute(value) ? value.replace(/^\/+/u, "") : value;
    const owner = packageDirectories.find((directory) => file.startsWith(`${directory}/`));
    for (const base of [dirname(file), root, ...(owner ? [owner] : [])]) {
      const target = resolve(base, path);
      if (target !== file && files.has(target)) return target;
    }
    return undefined;
  };
  const scan = (file: string, sourceText: string, prior = false): readonly string[] => {
    const source = parseSource(file, sourceText);
    const literals = prior ? [] : scanLiterals(source);
    if (resourcePaths.length > 0) {
      for (const path of resourcePaths) {
        if (!literals.some((literal) => referenceMatches(literal.value, path, file, root))) continue;
        const sources = fixtureSources.get(path) ?? [];
        sources.push(file);
        fixtureSources.set(path, sources);
      }
    }
    const targets: string[] = [];
    if (!prior) sources.set(file, source);
    for (const value of [
      ...literals.map((literal) => literal.value),
      ...(prior ? [] : joinedLiterals(source)),
    ]) {
      const target = entryReference(file, norm(value));
      if (!target) continue;
      addEdge(file, target);
      targets.push(target);
    }
    for (const line of literalDynamic(source))
      uncertain.add(`${norm(relative(root, file))}:${line}: computed import/require`);
    for (const edge of scanModuleEdgesFromSource(source)) {
      const specifier = edge.specifier;
      const targetBase = importBase(file, specifier);
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
      } else if (!SOURCE.test(targetBase) && extname(targetBase) && existsSync(targetBase)) {
        // A data import (JSON, text, TOML) is a leaf: Bun loads it, nothing is scanned.
        addEdge(file, targetBase);
        if (prior) priorEdges.add(`${file}\0${targetBase}`);
      } else
        uncertain.add(`${norm(relative(root, file))}:${edge.line}: unresolved local module ${specifier}`);
    }
    return targets;
  };
  const pending = [...eligible.map((path) => resolve(root, path)), ...preloads.roots];
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
    const mergeBase = await resolveMergeBase(root, options.baseRef, "HEAD");
    for (const path of changed.filter((path) => SOURCE.test(path))) {
      const content = await readFileAtCommit(root, mergeBase, path);
      if (content !== undefined) scan(resolve(root, path), content, true);
    }
  }
  const preloadModel = modelPreloads({ roots: preloads.roots, sources, resolveImport });
  for (const [from, to] of preloadModel.edges) addEdge(from, to);

  const witnesses = new Map<string, readonly string[]>();
  const matched = new Set<string>();
  const fixtureTests = new Set<string>();
  const priorTests = new Set<string>();
  const sharedPreloadTests = new Set<string>();
  const preloadGlobalTests = new Set<string>();
  const eligibleSet = new Set(eligible);
  const crosses = (witness: readonly string[], edges: ReadonlySet<string>): boolean =>
    witness.some((entry, index) => index > 0 && edges.has(`${entry}\0${witness[index - 1]}`));
  for (const changedPath of changed) {
    const rootPath = resolve(root, changedPath);
    const queue: string[][] = [[rootPath]];
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
          const first = witness[1];
          if (
            first &&
            !reverse.get(rootPath)?.has(first) &&
            fixtureSources.get(changedPath)?.includes(first)
          ) {
            fixtureTests.add(path);
          }
          if (crosses(witness, priorEdges)) priorTests.add(path);
          if (crosses(witness, preloadModel.globalEdges)) preloadGlobalTests.add(path);
          if (preloads.roots.includes(witness[witness.length - 2] ?? "")) {
            sharedPreloadTests.add(path);
          }
        }
      }
      for (const importer of sorted(reverse.get(node) ?? [])) {
        if (!preloadModel.lazyImports.has(`${importer}\0${node}`)) queue.push([...witness, importer]);
      }
      // Literal references come after import edges so an import witness wins.
      if (head === 0) queue.push(...(fixtureSources.get(changedPath) ?? []).map((file) => [rootPath, file]));
    }
  }
  if (broadReason) {
    const trigger = preloads.error
      ? "bunfig.toml"
      : (changed.find((path) => CONFIG.test(path)) ?? "bunfig.toml");
    for (const test of eligible) witnesses.set(test, [trigger, test]);
    fixtureTests.clear();
    priorTests.clear();
    sharedPreloadTests.clear();
    preloadGlobalTests.clear();
  }
  const unmatched = broadReason ? [] : changed.filter((path) => !matched.has(path));
  return {
    changed,
    eligibleCount: eligible.length,
    selected: sorted(witnesses.keys()),
    witnesses,
    fixtureTests: sorted(fixtureTests),
    priorTests: sorted(priorTests),
    sharedPreloadTests: sorted(sharedPreloadTests),
    preloadGlobalTests: sorted(preloadGlobalTests),
    unmatched,
    uncertain: sorted(uncertain),
    ...(broadReason ? { broadReason } : {}),
  };
};
