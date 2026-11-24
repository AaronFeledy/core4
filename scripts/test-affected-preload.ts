/**
 * Which tests a shared test preload's lazy loads reach, for `test-affected`.
 *
 * Every test depends on each preload root and on everything the root loads
 * while it runs. A `require()` or `import()` inside a function body runs only
 * when that function is called. When the only callers are the traps of a value
 * the root stores under a `globalThis` key (the test preload's lazy engine
 * composition), the module loads only in a test that reads that key. Such a
 * load is attributed to every file that names the key or reaches `globalThis`
 * through a computed access, not to every test. A lazy load this cannot verify
 * keeps the root's edge, so every test depends on it.
 */
import ts from "@typescript/typescript6";

export interface PreloadModel {
  /** `[reader, module]`: the reader loads `module` when it reads a preload global. */
  readonly edges: ReadonlyArray<readonly [string, string]>;
  /** `reader\0module` keys of `edges`, for witness labels. */
  readonly globalEdges: ReadonlySet<string>;
  /** `root\0module` keys of verified lazy loads, which are not edges to every test. */
  readonly lazyImports: ReadonlySet<string>;
}

export interface PreloadModelInput {
  readonly roots: readonly string[];
  /** Every scanned file, parsed, keyed by absolute path. */
  readonly sources: ReadonlyMap<string, ts.SourceFile>;
  readonly resolveImport: (from: string, specifier: string) => string | undefined;
}

const stringOf = (node: ts.Node | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

const isGlobalObject = (node: ts.Node | undefined): boolean =>
  node !== undefined && ts.isIdentifier(node) && node.text === "globalThis";

/** Top-level `const` declarations of a module, by name. */
const topLevelConsts = (source: ts.SourceFile): ReadonlyMap<string, ts.VariableDeclaration> => {
  const consts = new Map<string, ts.VariableDeclaration>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const))
      continue;
    for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name)) consts.set(declaration.name.text, declaration);
  }
  return consts;
};

/** `globalThis.K = V`, `globalThis["K"] = V`, or `Reflect.set(globalThis, "K", V)` at top level. */
const globalDefinitions = (
  source: ts.SourceFile,
  consts: ReadonlyMap<string, ts.VariableDeclaration>,
): ReadonlyArray<{ readonly key: string; readonly value: string; readonly statement: ts.Statement }> => {
  const staticKey = (node: ts.Node | undefined): string | undefined =>
    stringOf(node) ??
    (node && ts.isIdentifier(node) ? stringOf(consts.get(node.text)?.initializer) : undefined);
  const definitions: { key: string; value: string; statement: ts.Statement }[] = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    let key: string | undefined;
    let value: ts.Expression | undefined;
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left } = expression;
      if (ts.isPropertyAccessExpression(left) && isGlobalObject(left.expression)) key = left.name.text;
      if (ts.isElementAccessExpression(left) && isGlobalObject(left.expression))
        key = staticKey(left.argumentExpression);
      value = expression.right;
    } else if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.getText(source) === "Reflect.set" &&
      isGlobalObject(expression.arguments[0])
    ) {
      key = staticKey(expression.arguments[1]);
      value = expression.arguments[2];
    }
    if (key && value && ts.isIdentifier(value)) definitions.push({ key, value: value.text, statement });
  }
  return definitions;
};

const references = (source: ts.SourceFile, name: string): readonly ts.Identifier[] => {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
    )
      found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const within = (node: ts.Node, container: ts.Node | undefined): boolean =>
  container !== undefined && node.pos >= container.pos && node.end <= container.end;

/** True when `node` sits in a function body inside `container`, so evaluating `container` does not run it. */
const deferredWithin = (node: ts.Node, container: ts.Node | undefined): boolean => {
  for (let current = node.parent; container && current && current !== container; current = current.parent)
    if (ts.isFunctionLike(current)) return within(current, container);
  return false;
};

/** Global keys whose readers alone can call the top-level const function `name`, or undefined. */
const lazyLoadKeys = (source: ts.SourceFile, name: string): readonly string[] | undefined => {
  const consts = topLevelConsts(source);
  const loader = consts.get(name);
  const definitions = globalDefinitions(source, consts);
  const keys = new Set<string>();
  for (const reference of references(source, name)) {
    if (within(reference, loader)) continue;
    const holder = definitions.find((definition) =>
      deferredWithin(reference, consts.get(definition.value)?.initializer),
    );
    if (!holder) return undefined;
    // The value holding the loader may only be stored under global keys or compared inside the loader.
    for (const use of references(source, holder.value)) {
      const stored = definitions.find(
        (definition) => definition.value === holder.value && within(use, definition.statement),
      );
      if (!stored && !within(use, loader)) return undefined;
      if (stored) keys.add(stored.key);
    }
  }
  return keys.size > 0 ? [...keys] : undefined;
};

/** The top-level const function a lazy `import()`/`require()` call runs in, or undefined when it is eager. */
const enclosingLoader = (call: ts.CallExpression): string | undefined => {
  let node: ts.Node = call;
  let inFunction = false;
  while (!ts.isSourceFile(node.parent)) {
    if (ts.isFunctionLike(node)) inFunction = true;
    node = node.parent;
  }
  if (!inFunction || !ts.isVariableStatement(node)) return undefined;
  const [declaration] = node.declarationList.declarations;
  const initializer = declaration?.initializer;
  const isFunction = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
  return isFunction && within(call, initializer) && ts.isIdentifier(declaration.name)
    ? declaration.name.text
    : undefined;
};

const REFLECT_KEYED = new Set(["Reflect.get", "Reflect.has", "Reflect.set", "Reflect.deleteProperty"]);

/** A string literal, or a `Symbol.for(...)` key that can never equal a string key. */
const isKnownKey = (node: ts.Node | undefined): boolean =>
  stringOf(node) !== undefined ||
  (node !== undefined &&
    ts.isCallExpression(node) &&
    node.expression.getText() === "Symbol.for" &&
    stringOf(node.arguments[0]) !== undefined);

/** True when the global object is used other than with a key written in the source, so any key may be read. */
const readsAnyGlobal = (source: ts.SourceFile): boolean => {
  if (!source.text.includes("globalThis")) return false;
  const visit = (node: ts.Node): boolean => {
    if (ts.isTypeQueryNode(node)) return false;
    if (ts.isIdentifier(node) && node.text === "globalThis") {
      const { parent } = node;
      if ("name" in parent && parent.name === node) return false;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return false;
      if (ts.isElementAccessExpression(parent) && parent.expression === node)
        return !isKnownKey(parent.argumentExpression);
      const keyed =
        ts.isCallExpression(parent) &&
        parent.arguments[0] === node &&
        REFLECT_KEYED.has(parent.expression.getText()) &&
        isKnownKey(parent.arguments[1]);
      return !keyed;
    }
    return ts.forEachChild(node, visit) === true;
  };
  return visit(source);
};

export const modelPreloads = (input: PreloadModelInput): PreloadModel => {
  const edges: (readonly [string, string])[] = [];
  const globalEdges = new Set<string>();
  const lazyImports = new Set<string>();
  const lazy = new Map<string, Set<string>>();
  for (const root of input.roots) {
    const source = input.sources.get(root);
    if (!source) continue;
    const eager = new Set<string>();
    const loads: { target: string; loader: string | undefined }[] = [];
    const visit = (node: ts.Node): void => {
      const isLoad =
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"));
      const specifier = isLoad ? stringOf(node.arguments[0]) : undefined;
      const target = specifier && input.resolveImport(root, specifier);
      if (target && ts.isCallExpression(node)) loads.push({ target, loader: enclosingLoader(node) });
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const resolved = input.resolveImport(root, stringOf(node.moduleSpecifier) ?? "");
        if (resolved) eager.add(resolved);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const { target, loader } of loads) if (loader === undefined) eager.add(target);
    for (const { target, loader } of loads) {
      const keys = loader === undefined || eager.has(target) ? undefined : lazyLoadKeys(source, loader);
      if (!keys) continue;
      lazyImports.add(`${root}\0${target}`);
      const targetKeys = lazy.get(target) ?? new Set<string>();
      for (const key of keys) targetKeys.add(key);
      lazy.set(target, targetKeys);
    }
  }
  if (lazy.size === 0) return { edges, globalEdges, lazyImports };
  const anyGlobal = new Set(
    [...input.sources].filter(([, source]) => readsAnyGlobal(source)).map(([path]) => path),
  );
  for (const [target, keys] of lazy) {
    for (const [reader, source] of input.sources) {
      if (input.roots.includes(reader)) continue;
      if (!anyGlobal.has(reader) && ![...keys].some((key) => source.text.includes(key))) continue;
      edges.push([reader, target]);
      globalEdges.add(`${reader}\0${target}`);
    }
  }
  return { edges, globalEdges, lazyImports };
};
