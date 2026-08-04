import ts from "typescript";

import { resolveConstString, scanLiteralsAndComments } from "../literals.ts";
import type { BoundaryRule } from "../types.ts";

const SIGNALS = ["atomic-write-rename", "lockfile", "version-envelope"] as const;
const FS_MODULES = new Set(["fs", "fs/promises", "node:fs", "node:fs/promises"]);
const TEMP_NAME = /^temp(?:Path|File|Name)?$/iu;
const MAGIC_HEADER = /MAGIC|magic header|HEADER_BYTES/u;
const VERSION_NAME = /^(?:schemaVersion|CACHE_SCHEMA_VERSION|version)$/u;

type ScanState = {
  readonly calls: Map<string, readonly ts.CallExpression[]>;
  readonly identifiers: Set<string>;
  readonly objects: readonly ts.ObjectLiteralExpression[];
  readonly source: ts.SourceFile;
};

const propertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
};

const objectKeys = (object: ts.ObjectLiteralExpression): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const name = propertyName(property.name);
      if (name !== undefined) keys.add(name);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      keys.add(property.name.text);
    }
  }
  return keys;
};

const fsBindings = (source: ts.SourceFile): ReadonlyMap<string, string> => {
  const aliases = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!FS_MODULES.has(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || ts.isNamespaceImport(bindings)) continue;
    for (const element of bindings.elements) {
      aliases.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }
  return aliases;
};

const calledName = (
  expression: ts.LeftHandSideExpression,
  aliases: ReadonlyMap<string, string>,
): string | undefined => {
  if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
};

const scan = (source: ts.SourceFile): ScanState => {
  const aliases = fsBindings(source);
  const calls = new Map<string, ts.CallExpression[]>();
  const identifiers = new Set<string>();
  const objects: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (ts.isObjectLiteralExpression(node)) objects.push(node);
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression, aliases);
      if (name !== undefined) calls.set(name, [...(calls.get(name) ?? []), node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, identifiers, objects, source };
};

const expressionContainsTempMarker = (expression: ts.Expression, source: ts.SourceFile): boolean => {
  const folded = resolveConstString(expression, source);
  if (folded?.includes(".tmp-") || folded?.includes("tmp-")) return true;
  if (ts.isIdentifier(expression) && TEMP_NAME.test(expression.text)) return true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      (node.text.includes(".tmp-") || node.text.includes("tmp-"))
    ) {
      found = true;
      return;
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (node.text.includes(".tmp-") || node.text.includes("tmp-")) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
};

const hasAtomicWriteRename = (state: ScanState): boolean => {
  const writes = [...(state.calls.get("writeFile") ?? []), ...(state.calls.get("writeFileSync") ?? [])];
  const hasTempWrite = writes.some((call) => {
    const path = call.arguments[0];
    return path !== undefined && expressionContainsTempMarker(path, state.source);
  });
  return (
    hasTempWrite &&
    ((state.calls.get("rename")?.length ?? 0) > 0 || (state.calls.get("renameSync")?.length ?? 0) > 0)
  );
};

const hasLockfile = (state: ScanState): boolean => {
  if (state.identifiers.has("O_EXCL")) return true;
  const opens = [...(state.calls.get("open") ?? []), ...(state.calls.get("openSync") ?? [])];
  if (
    opens.some(
      (call) =>
        call.arguments[1] !== undefined && resolveConstString(call.arguments[1], state.source) === "wx",
    )
  ) {
    return true;
  }
  const literals = scanLiteralsAndComments(state.source);
  const hasLockPath = literals.some(({ value }) => /\.lock\b/u.test(value));
  const hasLifecycle =
    (state.calls.get("unlink")?.length ?? 0) > 0 ||
    (state.calls.get("unlinkSync")?.length ?? 0) > 0 ||
    state.identifiers.has("EEXIST") ||
    literals.some(({ value }) => /\bEEXIST\b/u.test(value));
  return hasLockPath && hasLifecycle;
};

const unwrapConstObject = (
  expression: ts.Expression,
  source: ts.SourceFile,
  seen: ReadonlySet<ts.Expression> = new Set(),
): ts.ObjectLiteralExpression | undefined => {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrapConstObject(expression.expression, source, seen);
  }
  if (!ts.isIdentifier(expression)) return undefined;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0)
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === expression.text &&
        declaration.initializer !== undefined &&
        !seen.has(declaration.initializer)
      ) {
        return unwrapConstObject(
          declaration.initializer,
          source,
          new Set([...seen, declaration.initializer]),
        );
      }
    }
  }
  return undefined;
};

const isJsonStringify = (call: ts.CallExpression): boolean =>
  ts.isPropertyAccessExpression(call.expression) &&
  ts.isIdentifier(call.expression.expression) &&
  call.expression.expression.text === "JSON" &&
  call.expression.name.text === "stringify";

const hasVersionEnvelope = (state: ScanState): boolean => {
  for (const call of state.calls.get("stringify") ?? []) {
    if (!isJsonStringify(call)) continue;
    const argument = call.arguments[0];
    const object = argument === undefined ? undefined : unwrapConstObject(argument, state.source);
    if (object !== undefined && objectKeys(object).has("version")) return true;
  }
  if (
    state.objects.some((object) => {
      const keys = objectKeys(object);
      return keys.has("version") && keys.has("data");
    })
  ) {
    return true;
  }
  const hasMagicHeader =
    scanLiteralsAndComments(state.source).some(({ value }) => MAGIC_HEADER.test(value)) ||
    [...state.identifiers].some((name) =>
      /^(?:MAGIC|HEADER_BYTES|writeBigUInt(?:32|64)BE|readBigUInt(?:32|64)BE)$/u.test(name),
    );
  return hasMagicHeader && [...state.identifiers].some((name) => VERSION_NAME.test(name));
};

export const stateStoreRule = {
  id: "state-store",
  scope: { roots: ["core/src", "plugins"], extensions: [".ts"], excludeTestFiles: true },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "State-store boundary check passed.",
  failureHeadline:
    "State-store boundary check failed. Hand-rolled atomic-write + lockfile + version-envelope logic is forbidden outside @lando/state-store.",
  onProgram: async (context) => {
    for (const file of context.files) {
      const state = scan(await context.sourceFile(file));
      const signals = [
        ...(hasAtomicWriteRename(state) ? [SIGNALS[0]] : []),
        ...(hasLockfile(state) ? [SIGNALS[1]] : []),
        ...(hasVersionEnvelope(state) ? [SIGNALS[2]] : []),
      ];
      if (signals.length === SIGNALS.length) context.report(file.relativePath, 1, signals.join(", "));
    }
  },
} satisfies BoundaryRule;
