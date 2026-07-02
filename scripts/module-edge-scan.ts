/**
 * Shared boundary-gate module-edge scanner.
 *
 * Boundary gates that reason about "what does this file pull in" must see more
 * than static `import` declarations: a banned dependency can slip in through a
 * dynamic `import(...)` (including a constructed specifier assembled from
 * string constants), a CommonJS `require(...)`, or a barrel re-export
 * (`export * from` / `export { x } from`). This module extracts all of those
 * edges from a TypeScript source file in one AST pass so every gate applies
 * the same escape-hatch coverage.
 */
import ts from "typescript";

export type ModuleEdgeKind = "import" | "dynamic-import" | "require" | "re-export";

export interface ModuleEdge {
  readonly kind: ModuleEdgeKind;
  /**
   * The module specifier, when it is statically resolvable. Dynamic
   * `import()` / `require()` arguments that cannot be evaluated at scan time
   * (runtime-computed paths) yield no edge — a gate cannot match what it
   * cannot resolve.
   */
  readonly specifier: string;
  /** 1-based line of the edge in the scanned file. */
  readonly line: number;
  /**
   * Module-side names pulled through this edge: imported names for `import`
   * edges (property name before any `as` alias) and re-exported names for
   * `re-export` edges. Empty for namespace/star/dynamic/require edges.
   */
  readonly names: ReadonlyArray<string>;
}

/**
 * Resolve an identifier USE to the `const` initializer that lexically binds
 * it, or `undefined` when no statically known `const` binding is in scope.
 */
export type ConstBindingResolver = (identifier: ts.Identifier) => ts.Expression | undefined;

/**
 * Statically evaluate a specifier expression: string literals, template
 * literals, `+` concatenation, parenthesized expressions, and identifiers
 * bound by a same-file `const` whose initializer is itself statically
 * evaluable (the constructed-specifier pattern, e.g.
 * `const mod = "@scope/" + "pkg"; await import(mod)`).
 */
export const resolveStaticString = (
  expression: ts.Expression,
  resolveBinding: ConstBindingResolver,
  seen: ReadonlySet<ts.Expression> = new Set(),
): string | undefined => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return resolveStaticString(expression.expression, resolveBinding, seen);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStaticString(expression.left, resolveBinding, seen);
    if (left === undefined) return undefined;
    const right = resolveStaticString(expression.right, resolveBinding, seen);
    return right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let result = expression.head.text;
    for (const span of expression.templateSpans) {
      const value = resolveStaticString(span.expression, resolveBinding, seen);
      if (value === undefined) return undefined;
      result += value + span.literal.text;
    }
    return result;
  }
  if (ts.isIdentifier(expression)) {
    const initializer = resolveBinding(expression);
    if (initializer === undefined || seen.has(initializer)) return undefined;
    return resolveStaticString(initializer, resolveBinding, new Set([...seen, initializer]));
  }
  return undefined;
};

/**
 * Nodes that open a lexical scope for `const` declarations. Function bodies
 * are `Block`s, so this list covers module scope, block statements, `case`
 * blocks, namespace bodies, and `for` heads (`for (const x of ...)`).
 */
const isConstScopeBoundary = (node: ts.Node): boolean =>
  ts.isSourceFile(node) ||
  ts.isBlock(node) ||
  ts.isModuleBlock(node) ||
  ts.isCaseBlock(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node);

const enclosingConstScope = (node: ts.Node): ts.Node => {
  let current: ts.Node = node;
  while (!isConstScopeBoundary(current)) current = current.parent;
  return current;
};

/**
 * Index every same-file `const` binding BY ITS LEXICAL SCOPE, and return a
 * resolver that walks an identifier use outward through its enclosing scopes
 * to the nearest binding. A flat name-keyed map would let a later block- or
 * function-scoped `const` overwrite the module-scope binding that actually
 * resolves a dynamic `import()` / `require()` argument, making the gate
 * evaluate the wrong module string and miss a boundary violation.
 */
const collectConstBindings = (source: ts.SourceFile): ConstBindingResolver => {
  const scopes = new Map<ts.Node, Map<string, ts.Expression>>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      const scope = enclosingConstScope(node);
      const bindings = scopes.get(scope) ?? new Map<string, ts.Expression>();
      scopes.set(scope, bindings);
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          bindings.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  return (identifier) => {
    for (let node: ts.Node | undefined = identifier.parent; node !== undefined; node = node.parent) {
      const binding = scopes.get(node)?.get(identifier.text);
      if (binding !== undefined) return binding;
    }
    return undefined;
  };
};

const namedImportNames = (importClause: ts.ImportClause | undefined): ReadonlyArray<string> => {
  const namedBindings = importClause?.namedBindings;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return [];
  return namedBindings.elements.map((element) => element.propertyName?.text ?? element.name.text);
};

const namedReExportNames = (exportClause: ts.NamedExportBindings | undefined): ReadonlyArray<string> => {
  if (!exportClause || !ts.isNamedExports(exportClause)) return [];
  return exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text);
};

const isRequireCall = (node: ts.CallExpression): boolean =>
  ts.isIdentifier(node.expression) && node.expression.text === "require";

/**
 * Extract every module edge from a source file: static imports, statically
 * resolvable dynamic `import()` / `require()` calls, and re-export
 * declarations. Line numbers are 1-based.
 */
export const scanModuleEdges = (fileName: string, sourceText: string): ReadonlyArray<ModuleEdge> => {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const resolveConstBinding = collectConstBindings(source);
  const edges: ModuleEdge[] = [];

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({
        kind: "import",
        specifier: node.moduleSpecifier.text,
        line: lineOf(node),
        names: namedImportNames(node.importClause),
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
        edges.push({
          kind: "re-export",
          specifier: node.moduleSpecifier.text,
          line: lineOf(node),
          names: namedReExportNames(node.exportClause),
        });
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isDynamicImport || isRequireCall(node)) && node.arguments.length >= 1) {
        const argument = node.arguments[0];
        const specifier =
          argument === undefined ? undefined : resolveStaticString(argument, resolveConstBinding);
        if (specifier !== undefined) {
          edges.push({
            kind: isDynamicImport ? "dynamic-import" : "require",
            specifier,
            line: lineOf(node),
            names: [],
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return edges;
};
