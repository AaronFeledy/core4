import ts from "typescript";

import { FORBIDDEN_EFFECT_MEMBERS, type ModuleProbeBindings } from "./probe-bindings.ts";

export interface ProbeScanViolation {
  readonly line: number;
  readonly detail: string;
}

const bindingElementMemberName = (element: ts.BindingElement): string | undefined => {
  if (element.dotDotDotToken !== undefined) return undefined;
  if (element.propertyName !== undefined) {
    if (ts.isIdentifier(element.propertyName)) return element.propertyName.text;
    if (ts.isStringLiteral(element.propertyName)) return element.propertyName.text;
    return undefined;
  }
  if (ts.isIdentifier(element.name)) return element.name.text;
  return undefined;
};

interface LocalAliases {
  readonly effect: Map<string, string>;
  readonly schedule: Map<string, string>;
}

const registerDestructuredNamespaceMembers = (
  pattern: ts.ObjectBindingPattern,
  namespaceKind: "effect" | "schedule",
  aliases: LocalAliases,
): void => {
  for (const element of pattern.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const member = bindingElementMemberName(element);
    if (member === undefined) continue;
    if (namespaceKind === "effect") {
      if (FORBIDDEN_EFFECT_MEMBERS.has(member)) aliases.effect.set(element.name.text, member);
      continue;
    }
    aliases.schedule.set(element.name.text, member);
  }
};

const extendScopeFromVariableDeclaration = (
  declaration: ts.VariableDeclaration,
  bindings: ModuleProbeBindings,
  aliases: LocalAliases,
): void => {
  const initializer = declaration.initializer;
  if (initializer === undefined || !ts.isObjectBindingPattern(declaration.name)) return;
  if (ts.isIdentifier(initializer) && bindings.effectAliases.has(initializer.text)) {
    registerDestructuredNamespaceMembers(declaration.name, "effect", aliases);
    return;
  }
  if (ts.isIdentifier(initializer) && bindings.scheduleAliases.has(initializer.text)) {
    registerDestructuredNamespaceMembers(declaration.name, "schedule", aliases);
  }
};

const copyAliases = (aliases: LocalAliases): LocalAliases => ({
  effect: new Map(aliases.effect),
  schedule: new Map(aliases.schedule),
});

export const scanProbeSource = (
  source: ts.SourceFile,
  bindings: ModuleProbeBindings,
): readonly ProbeScanViolation[] => {
  const violations: ProbeScanViolation[] = [];
  const record = (node: ts.Node, detail: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({ line: line + 1, detail });
  };

  const visitStatements = (statements: readonly ts.Statement[], parentAliases: LocalAliases): void => {
    const aliases = copyAliases(parentAliases);
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          extendScopeFromVariableDeclaration(declaration, bindings, aliases);
        }
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.initializer !== undefined) visit(declaration.initializer, aliases);
        }
        continue;
      }
      visit(statement, aliases);
    }
  };

  const visitForInitializer = (
    initializer: ts.ForInitializer | undefined,
    parentAliases: LocalAliases,
  ): void => {
    if (initializer === undefined) return;
    if (!ts.isVariableDeclarationList(initializer)) {
      visit(initializer, parentAliases);
      return;
    }
    const aliases = copyAliases(parentAliases);
    for (const declaration of initializer.declarations) {
      extendScopeFromVariableDeclaration(declaration, bindings, aliases);
    }
    for (const declaration of initializer.declarations) {
      if (declaration.initializer !== undefined) visit(declaration.initializer, aliases);
    }
  };

  const visitPropertyAccess = (node: ts.PropertyAccessExpression): void => {
    const member = node.name.text;
    if (ts.isIdentifier(node.expression)) {
      const object = node.expression.text;
      if (bindings.effectAliases.has(object) && FORBIDDEN_EFFECT_MEMBERS.has(member)) {
        record(node, `Effect.${member}`);
      }
      if (bindings.scheduleAliases.has(object)) record(node, `Schedule.${member}`);
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      bindings.effectAliases.has(node.expression.expression.text) &&
      node.expression.name.text === "Schedule"
    ) {
      record(node, `Schedule.${member}`);
    }
  };

  const visitCall = (node: ts.CallExpression, aliases: LocalAliases): void => {
    if (!ts.isIdentifier(node.expression)) return;
    const callee = node.expression.text;
    const effectMember = bindings.effectMemberAliases.get(callee) ?? aliases.effect.get(callee);
    if (effectMember !== undefined) record(node.expression, `Effect.${effectMember}`);
    const scheduleMember = bindings.scheduleMemberAliases.get(callee) ?? aliases.schedule.get(callee);
    if (scheduleMember !== undefined) record(node.expression, `Schedule.${scheduleMember}`);
  };

  const visit = (node: ts.Node, aliases: LocalAliases): void => {
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      visitStatements(node.statements, aliases);
      return;
    }
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      visitStatements(node.statements, aliases);
      return;
    }
    if (ts.isForStatement(node)) {
      visitForInitializer(node.initializer, aliases);
      const loopAliases = copyAliases(aliases);
      if (node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          extendScopeFromVariableDeclaration(declaration, bindings, loopAliases);
        }
      }
      if (node.condition !== undefined) visit(node.condition, loopAliases);
      if (node.incrementor !== undefined) visit(node.incrementor, loopAliases);
      visit(node.statement, loopAliases);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) visitPropertyAccess(node);
    if (ts.isCallExpression(node)) visitCall(node, aliases);
    ts.forEachChild(node, (child) => visit(child, aliases));
  };

  visit(source, { effect: new Map(), schedule: new Map() });
  return violations;
};
