import ts from "typescript";

import { type ConstBindingResolver, resolveStaticString } from "../module-edge-scan.ts";

interface PositionedValue {
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
}

export interface LiteralValue extends PositionedValue {
  readonly kind: "string" | "template-part" | "regex";
}

export interface CommentValue extends PositionedValue {
  readonly kind: "line-comment" | "block-comment";
}

export type LiteralOrComment = LiteralValue | CommentValue;

const positioned = (source: ts.SourceFile, value: string, start: number, end: number): PositionedValue => ({
  value,
  start,
  end,
  line: source.getLineAndCharacterOfPosition(start).line + 1,
});

export const scanLiterals = (source: ts.SourceFile): readonly LiteralValue[] => {
  const values: LiteralValue[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.push({
        kind: "string",
        ...positioned(source, node.text, node.getStart(source), node.getEnd()),
      });
    } else if (ts.isTemplateExpression(node)) {
      values.push({
        kind: "template-part",
        ...positioned(source, node.head.text, node.head.getStart(source), node.head.getEnd()),
      });
      for (const span of node.templateSpans) {
        values.push({
          kind: "template-part",
          ...positioned(source, span.literal.text, span.literal.getStart(source), span.literal.getEnd()),
        });
      }
    } else if (ts.isRegularExpressionLiteral(node)) {
      values.push({
        kind: "regex",
        ...positioned(source, node.text, node.getStart(source), node.getEnd()),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values.sort((left, right) => left.start - right.start || left.end - right.end);
};

export const scanComments = (source: ts.SourceFile): readonly CommentValue[] => {
  const comments: CommentValue[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source.text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) {
      continue;
    }
    const start = scanner.getTokenStart();
    const end = scanner.getTokenEnd();
    comments.push({
      kind: token === ts.SyntaxKind.SingleLineCommentTrivia ? "line-comment" : "block-comment",
      ...positioned(source, source.text.slice(start, end), start, end),
    });
  }
  return comments;
};

export const scanLiteralsAndComments = (source: ts.SourceFile): readonly LiteralOrComment[] =>
  [...scanLiterals(source), ...scanComments(source)].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );

const isConstScopeBoundary = (node: ts.Node): boolean =>
  ts.isSourceFile(node) ||
  ts.isBlock(node) ||
  ts.isModuleBlock(node) ||
  ts.isCaseBlock(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node);

const enclosingConstScope = (node: ts.Node): ts.Node => {
  let current = node;
  while (!isConstScopeBoundary(current) && current.parent !== undefined) current = current.parent;
  return current;
};

const constBindingResolver = (source: ts.SourceFile): ConstBindingResolver => {
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

export const resolveConstString = (expression: ts.Expression, source: ts.SourceFile): string | undefined =>
  resolveStaticString(expression, constBindingResolver(source));
