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
 * Statically evaluate a specifier expression: string literals, template
 * literals, `+` concatenation, parenthesized expressions, and identifiers
 * bound by a same-file `const` whose initializer is itself statically
 * evaluable (the constructed-specifier pattern, e.g.
 * `const mod = "@scope/" + "pkg"; await import(mod)`).
 */
export const resolveStaticString = (
  expression: ts.Expression,
  constBindings: ReadonlyMap<string, ts.Expression>,
  seen: ReadonlySet<string> = new Set(),
): string | undefined => {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return resolveStaticString(expression.expression, constBindings, seen);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStaticString(expression.left, constBindings, seen);
    if (left === undefined) return undefined;
    const right = resolveStaticString(expression.right, constBindings, seen);
    return right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let result = expression.head.text;
    for (const span of expression.templateSpans) {
      const value = resolveStaticString(span.expression, constBindings, seen);
      if (value === undefined) return undefined;
      result += value + span.literal.text;
    }
    return result;
  }
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return undefined;
    const initializer = constBindings.get(expression.text);
    if (initializer === undefined) return undefined;
    return resolveStaticString(initializer, constBindings, new Set([...seen, expression.text]));
  }
  return undefined;
};

const collectConstBindings = (source: ts.SourceFile): ReadonlyMap<string, ts.Expression> => {
  const bindings = new Map<string, ts.Expression>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          bindings.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return bindings;
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
  const constBindings = collectConstBindings(source);
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
        const specifier = argument === undefined ? undefined : resolveStaticString(argument, constBindings);
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
