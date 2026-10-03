import ts from "typescript";

import type { BoundaryRule } from "../types.ts";
import { CORE_AND_PLUGIN_SOURCE_ROOTS } from "../workspace-roots.ts";

const unwrap = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return unwrap(expression.expression);
  return expression;
};

const importedPath = (expression: ts.Expression, checker: ts.TypeChecker): string | undefined => {
  const node = unwrap(expression);
  if (ts.isPropertyAccessExpression(node)) {
    const base = importedPath(node.expression, checker);
    return base === undefined ? undefined : `${base}/${node.name.text}`;
  }
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
  if (declaration === undefined) return undefined;
  if (ts.isImportSpecifier(declaration)) {
    const statement = declaration.parent.parent.parent;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      return `${statement.moduleSpecifier.text}/${(declaration.propertyName ?? declaration.name).text}`;
    }
  }
  if (ts.isNamespaceImport(declaration)) {
    const statement = declaration.parent.parent;
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      return statement.moduleSpecifier.text;
    }
  }
  return undefined;
};

const returnedExpression = (body: ts.ConciseBody): ts.Expression | undefined => {
  if (!ts.isBlock(body)) return unwrap(body);
  const statement = body.statements[0];
  if (body.statements.length === 1 && statement !== undefined && ts.isReturnStatement(statement)) {
    return statement.expression === undefined ? undefined : unwrap(statement.expression);
  }
  return undefined;
};

const hasNamedOwner = (node: ts.ArrowFunction | ts.FunctionExpression): boolean => {
  let owner: ts.Node = node.parent;
  while (ts.isParenthesizedExpression(owner) || ts.isAsExpression(owner) || ts.isSatisfiesExpression(owner)) {
    owner = owner.parent;
  }
  return (
    (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) ||
    ts.isPropertyDeclaration(owner) ||
    ts.isPropertyAssignment(owner)
  );
};

const exported = (node: ts.Node): boolean => {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node) ?? [];
  return (
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    !modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
  );
};

export const effectIdiomsRule = {
  id: "effect-idioms",
  scope: {
    roots: CORE_AND_PLUGIN_SOURCE_ROOTS,
    extensions: [".ts"],
    excludeDirNames: ["dist", "node_modules"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Effect idioms boundary check passed.",
  failureHeadline:
    "Effect idioms boundary check failed. Use Schema errors, Clock/DateTime, Effect.fn, Predicate.isObject, layer exports, and effect subpath imports instead of retired Effect idioms.",
  onProgram: async (context) => {
    const sources = await Promise.all(context.files.map((file) => context.sourceFile(file)));
    const byName = new Map(sources.map((source) => [source.fileName, source]));
    const options: ts.CompilerOptions = { noLib: true, noResolve: true };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name) => byName.get(name);
    const checker = ts.createProgram([...byName.keys()], options, host).getTypeChecker();
    for (const [index, source] of sources.entries()) {
      const file = context.files[index];
      if (file === undefined) continue;
      const report = (node: ts.Node, detail: string): void => {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        context.report(file.relativePath, line + 1, detail);
      };
      const importsEffect = source.statements.some(
        (statement) =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          (statement.moduleSpecifier.text === "effect" ||
            statement.moduleSpecifier.text.startsWith("effect/")),
      );
      const localName = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) {
          if (["isRecord", "isPlainObject", "isObject"].includes(name.text)) {
            report(name, `Local ${name.text} definition; use Predicate.isObject`);
          }
        } else {
          for (const element of name.elements) {
            if (ts.isBindingElement(element)) localName(element.name);
          }
        }
      };
      const liveName = (name: ts.Node): void => {
        if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text.endsWith("Live")) {
          report(name, `Export ${name.text}; use layer or layer<Variant>`);
        }
      };
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const specifier = node.moduleSpecifier;
          if (
            specifier !== undefined &&
            ts.isStringLiteral(specifier) &&
            specifier.text.startsWith("@effect/")
          ) {
            report(specifier, `Import ${specifier.text}; use effect subpaths`);
          }
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const specifier = node.arguments[0];
          if (
            specifier !== undefined &&
            ts.isStringLiteralLike(specifier) &&
            specifier.text.startsWith("@effect/")
          ) {
            report(specifier, `Import ${specifier.text}; use effect subpaths`);
          }
        }
        if (
          ts.isPropertyAccessExpression(node) ||
          (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent))
        ) {
          const path = importedPath(node, checker);
          if (path === "effect/Data/TaggedError" || path === "effect/Data/Error") {
            report(
              node,
              `Data.${path.endsWith("TaggedError") ? "TaggedError" : "Error"}; use Schema.TaggedError`,
            );
          }
        }
        if (importsEffect && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
          const callee = unwrap(node.expression);
          if (
            ts.isNewExpression(node) &&
            ts.isIdentifier(callee) &&
            callee.text === "Date" &&
            checker.getSymbolAtLocation(callee) === undefined
          ) {
            report(node, "new Date; use DateTime in Effect modules");
          }
          if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Date" &&
            callee.name.text === "now" &&
            checker.getSymbolAtLocation(callee.expression) === undefined
          ) {
            report(node, "Date.now(); use Clock.currentTimeMillis");
          }
        }
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)
        ) {
          const named = ts.isFunctionDeclaration(node)
            ? node.name !== undefined
            : ts.isMethodDeclaration(node) || hasNamedOwner(node);
          const expression = node.body === undefined ? undefined : returnedExpression(node.body);
          if (
            named &&
            expression !== undefined &&
            ts.isCallExpression(expression) &&
            importedPath(expression.expression, checker) === "effect/Effect/gen"
          ) {
            report(node, "Named wrapper only returns Effect.gen; use Effect.fn or Effect.fnUntraced");
          }
        }
        if (ts.isVariableDeclaration(node)) localName(node.name);
        if (
          ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)
        ) {
          if (node.name !== undefined) localName(node.name);
          if (exported(node) && node.name !== undefined) liveName(node.name);
        }
        if (ts.isVariableStatement(node) && exported(node)) {
          const visitBinding = (name: ts.BindingName): void => {
            if (ts.isIdentifier(name)) liveName(name);
            else
              for (const element of name.elements)
                if (ts.isBindingElement(element)) visitBinding(element.name);
          };
          for (const declaration of node.declarationList.declarations) visitBinding(declaration.name);
        }
        if (ts.isExportSpecifier(node) || ts.isNamespaceExport(node)) liveName(node.name);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  },
} satisfies BoundaryRule;
