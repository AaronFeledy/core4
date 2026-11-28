import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";

import { loadWorkspacePackages, resolveFile, resolveWorkspaceSpecifier } from "./boundary/graph.ts";
import { listGitVisibleFiles } from "./git-changes.ts";

export const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/u;

export const norm = (value: string): string => value.replaceAll("\\", "/");
export const sorted = <T>(values: Iterable<T>): T[] => [...values].sort() as T[];

export const relativePath = (root: string, input: string): string => {
  const absolute = resolve(root, norm(input));
  const path = norm(relative(root, absolute));
  if (path === ".." || path.startsWith("../") || isAbsolute(path) || path === "") {
    throw new Error(`path must be a file inside the repository: ${input}`);
  }
  return path;
};

export const sourceFiles = async (root: string): Promise<Set<string>> => {
  const files = new Set<string>();
  // Git supplies source files in any package directory, including bin/ and
  // package-local tooling. The globs below also include ignored generated
  // modules that exist on disk after codegen.
  const listed = await listGitVisibleFiles(root);
  for (const path of listed) {
    if (SOURCE.test(path)) files.add(resolve(root, path));
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

export const configuredPreloads = async (
  root: string,
  files: ReadonlySet<string>,
  packages: Awaited<ReturnType<typeof loadWorkspacePackages>>,
): Promise<{ roots: readonly string[]; error?: string }> => {
  const config = Bun.file(resolve(root, "bunfig.toml"));
  if (!(await config.exists())) return { roots: [] };
  try {
    const document: unknown = Bun.TOML.parse(await config.text());
    if (typeof document !== "object" || document === null || Array.isArray(document))
      return { roots: [], error: "bunfig.toml is not a table" };
    const test: unknown = (document as Record<string, unknown>).test;
    if (test === undefined) return { roots: [] };
    if (typeof test !== "object" || test === null || Array.isArray(test))
      return { roots: [], error: "bunfig.toml [test] is not a table" };
    const configured: unknown = (test as Record<string, unknown>).preload;
    if (configured === undefined) return { roots: [] };
    const entries = typeof configured === "string" ? [configured] : configured;
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry))
      return { roots: [], error: "bunfig.toml test.preload is not a string or string array" };
    const roots: string[] = [];
    for (const entry of entries as string[]) {
      const base = entry.startsWith(".") ? resolve(root, entry) : resolveWorkspaceSpecifier(entry, packages);
      if (!base) return { roots: [], error: `unsupported test preload: ${entry}` };
      try {
        relativePath(root, base);
      } catch {
        return { roots: [], error: `test preload leaves repository: ${entry}` };
      }
      const file = resolveFile(base, files);
      if (!file) return { roots: [], error: `unresolved test preload: ${entry}` };
      roots.push(file);
    }
    return { roots: sorted(new Set(roots)) };
  } catch {
    return { roots: [], error: "bunfig.toml could not be parsed" };
  }
};

export const parseSource = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

export const literalDynamic = (source: ts.SourceFile): readonly number[] => {
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

/** Trailing literal segments of `join(...)`/`resolve(...)` calls, such as `join(repo, "core", "bin", "lando.ts")`. */
export const joinedLiterals = (source: ts.SourceFile): readonly string[] => {
  const joined: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && /(?:^|\.)(?:join|resolve)$/u.test(node.expression.getText(source))) {
      const segments: string[] = [];
      for (const argument of [...node.arguments].reverse()) {
        if (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument)) break;
        segments.unshift(argument.text);
      }
      if (segments.length > 1) joined.push(segments.join("/"));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return joined;
};

export const fixtureApp = (path: string): string | undefined => {
  const match = /^(.+?\/fixtures\/[^/]+|recipes\/[^/]+)(?:\/|$)/u.exec(path);
  return match?.[1];
};

export const referenceMatches = (literal: string, changed: string, source: string, root: string): boolean => {
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
