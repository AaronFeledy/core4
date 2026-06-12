import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

export interface DeprecationTsdocOffender {
  readonly file: string;
  readonly line: number;
  readonly exportName: string;
  readonly reason: string;
}

export interface DeprecationTsdocResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<DeprecationTsdocOffender>;
}

interface CheckDeprecationTsdocOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");
const SCANNED_ROOTS = ["sdk/src", "core/src", "plugins"] as const;
const MISSING_MARK_DEPRECATED_REASON = "missing markDeprecated(notice, impl) wrapper";
const MISMATCHED_MARK_DEPRECATED_ID_REASON = "markDeprecated export id must match exported name";
const MISSING_DEPRECATION_METADATA_REASON = "missing static readonly deprecation metadata";
const STALE_TSDOC_REASON = "@deprecated text must include DeprecationNotice note/replacement";
const INVALID_DEPRECATION_METADATA_REASON =
  "static readonly deprecation metadata is only accepted on tagged errors";

const collectTsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectTsFiles(full)));
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
    }

    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);

const hasExportModifier = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword);

const hasReadonlyModifier = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.ReadonlyKeyword);

const hasStaticModifier = (node: ts.Node): boolean => hasModifier(node, ts.SyntaxKind.StaticKeyword);

const hasDeprecatedTag = (node: ts.Node): boolean => ts.getJSDocDeprecatedTag(node) !== undefined;

const deprecatedTagText = (node: ts.Node): string => {
  const comment = ts.getJSDocDeprecatedTag(node)?.comment;
  if (comment === undefined) return "";
  if (typeof comment === "string") return comment;
  return comment.map((part) => part.text).join("");
};

const propertyNameText = (name: ts.PropertyName | ts.BindingName | undefined): string | undefined => {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
};

const isMarkDeprecatedCall = (expression: ts.Expression | undefined): boolean => {
  if (expression === undefined || !ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  if (ts.isIdentifier(callee)) return callee.text === "markDeprecated";
  if (ts.isPropertyAccessExpression(callee)) return propertyNameText(callee.name) === "markDeprecated";
  return false;
};

const markDeprecatedExportId = (expression: ts.Expression | undefined): string | undefined => {
  if (expression === undefined || !ts.isCallExpression(expression) || !isMarkDeprecatedCall(expression)) {
    return undefined;
  }

  const explicitId = stringLiteralValue(expression.arguments[1]);
  if (explicitId !== undefined) return explicitId;

  const impl = expression.arguments[1];
  if (impl === undefined) return undefined;
  if ((ts.isFunctionExpression(impl) || ts.isFunctionDeclaration(impl)) && impl.name !== undefined) {
    return impl.name.text;
  }
  return undefined;
};

const markDeprecatedTracksExport = (expression: ts.Expression | undefined, exportName: string): boolean =>
  markDeprecatedExportId(expression) === exportName;

interface NoticeText {
  readonly note?: string;
  readonly replacement?: string;
}

const stringLiteralValue = (expression: ts.Expression | undefined): string | undefined => {
  if (expression === undefined) return undefined;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return expression.text;
  return undefined;
};

const noticeTextFromObjectLiteral = (expression: ts.Expression | undefined): NoticeText | undefined => {
  if (expression === undefined || !ts.isObjectLiteralExpression(expression)) return undefined;
  const notice: { note?: string; replacement?: string } = {};
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (name === "note") notice.note = stringLiteralValue(property.initializer);
    if (name === "replacement") notice.replacement = stringLiteralValue(property.initializer);
  }
  return notice.note === undefined && notice.replacement === undefined ? undefined : notice;
};

const localNoticeBindings = (source: ts.SourceFile): ReadonlyMap<string, NoticeText> => {
  const bindings = new Map<string, NoticeText>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const name = propertyNameText(declaration.name);
      const notice = noticeTextFromObjectLiteral(declaration.initializer);
      if (name !== undefined && notice !== undefined) bindings.set(name, notice);
    }
  }
  return bindings;
};

const noticeTextFromExpression = (
  expression: ts.Expression | undefined,
  bindings: ReadonlyMap<string, NoticeText>,
): NoticeText | undefined => {
  if (expression === undefined) return undefined;
  if (ts.isIdentifier(expression)) return bindings.get(expression.text);
  return noticeTextFromObjectLiteral(expression);
};

const markDeprecatedNoticeText = (
  expression: ts.Expression | undefined,
  bindings: ReadonlyMap<string, NoticeText>,
): NoticeText | undefined => {
  if (expression === undefined || !ts.isCallExpression(expression)) return undefined;
  return noticeTextFromExpression(expression.arguments[0], bindings);
};

const tsdocMatchesNotice = (tsdoc: string, notice: NoticeText | undefined): boolean => {
  if (notice === undefined) return tsdoc.trim().length > 0;
  if (notice.note !== undefined && !tsdoc.includes(notice.note)) return false;
  if (notice.replacement !== undefined && !tsdoc.includes(notice.replacement)) return false;
  return true;
};

const isTaggedErrorClass = (node: ts.ClassDeclaration): boolean =>
  node.heritageClauses?.some((clause) =>
    clause.types.some((heritage) => heritage.expression.getText().includes("TaggedError")),
  ) ?? false;

const deprecationMetadata = (node: ts.ClassDeclaration): ts.PropertyDeclaration | undefined =>
  node.members.find(
    (member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) &&
      hasStaticModifier(member) &&
      hasReadonlyModifier(member) &&
      propertyNameText(member.name) === "deprecation",
  );

const hasTaggedErrorDeprecationMetadata = (node: ts.ClassDeclaration): boolean =>
  isTaggedErrorClass(node) && deprecationMetadata(node) !== undefined;

// JSDoc for `const x = ...` attaches to the enclosing VariableStatement, not the
// VariableDeclaration, so resolve the statement to detect a `@deprecated` local export.
const localDeclarationTagNode = (
  declaration: ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration,
): ts.Node => {
  if (ts.isVariableDeclaration(declaration)) {
    const statement = declaration.parent?.parent;
    if (statement !== undefined && ts.isVariableStatement(statement)) return statement;
  }
  return declaration;
};

const offender = (
  source: ts.SourceFile,
  file: string,
  node: ts.Node,
  exportName: string,
  reason: string,
): DeprecationTsdocOffender => {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file, line: line + 1, exportName, reason };
};

const scanFile = async (file: string): Promise<ReadonlyArray<DeprecationTsdocOffender>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: DeprecationTsdocOffender[] = [];
  const notices = localNoticeBindings(source);
  const localDeclarations = new Map<
    string,
    ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration
  >();

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = propertyNameText(declaration.name);
        if (name !== undefined) localDeclarations.set(name, declaration);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      localDeclarations.set(statement.name.text, statement);
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      localDeclarations.set(statement.name.text, statement);
    }
  }

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement) && hasDeprecatedTag(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const exportName = propertyNameText(declaration.name) ?? "<destructured>";
        if (!isMarkDeprecatedCall(declaration.initializer)) {
          offenders.push(offender(source, file, statement, exportName, MISSING_MARK_DEPRECATED_REASON));
        } else if (!markDeprecatedTracksExport(declaration.initializer, exportName)) {
          offenders.push(offender(source, file, statement, exportName, MISMATCHED_MARK_DEPRECATED_ID_REASON));
        } else if (
          !tsdocMatchesNotice(
            deprecatedTagText(statement),
            markDeprecatedNoticeText(declaration.initializer, notices),
          )
        ) {
          offenders.push(offender(source, file, statement, exportName, STALE_TSDOC_REASON));
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && hasDeprecatedTag(statement)) {
      offenders.push(
        offender(
          source,
          file,
          statement,
          statement.name?.text ?? "<default>",
          MISSING_MARK_DEPRECATED_REASON,
        ),
      );
      continue;
    }

    if (ts.isClassDeclaration(statement) && hasExportModifier(statement) && hasDeprecatedTag(statement)) {
      const exportName = statement.name?.text ?? "<default>";
      const metadata = deprecationMetadata(statement);
      if (metadata !== undefined && !isTaggedErrorClass(statement)) {
        offenders.push(offender(source, file, statement, exportName, INVALID_DEPRECATION_METADATA_REASON));
      } else if (!hasTaggedErrorDeprecationMetadata(statement)) {
        offenders.push(offender(source, file, statement, exportName, MISSING_DEPRECATION_METADATA_REASON));
      } else if (
        !tsdocMatchesNotice(
          deprecatedTagText(statement),
          noticeTextFromExpression(metadata?.initializer, notices),
        )
      ) {
        offenders.push(offender(source, file, statement, exportName, STALE_TSDOC_REASON));
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.moduleSpecifier === undefined
    ) {
      const exportTagged = hasDeprecatedTag(statement);
      for (const element of statement.exportClause.elements) {
        const exportedName = element.name.text;
        const localName = element.propertyName?.text ?? exportedName;
        const declaration = localDeclarations.get(localName);
        const localTagNode = declaration === undefined ? undefined : localDeclarationTagNode(declaration);
        const localTagged = localTagNode !== undefined && hasDeprecatedTag(localTagNode);
        if (!exportTagged && !localTagged) continue;
        const tagNode = exportTagged ? statement : (localTagNode as ts.Node);

        if (declaration === undefined) {
          offenders.push(offender(source, file, statement, exportedName, MISSING_MARK_DEPRECATED_REASON));
          continue;
        }

        if (ts.isVariableDeclaration(declaration)) {
          if (!isMarkDeprecatedCall(declaration.initializer)) {
            offenders.push(offender(source, file, statement, exportedName, MISSING_MARK_DEPRECATED_REASON));
          } else if (!markDeprecatedTracksExport(declaration.initializer, exportedName)) {
            offenders.push(
              offender(source, file, statement, exportedName, MISMATCHED_MARK_DEPRECATED_ID_REASON),
            );
          } else if (
            !tsdocMatchesNotice(
              deprecatedTagText(tagNode),
              markDeprecatedNoticeText(declaration.initializer, notices),
            )
          ) {
            offenders.push(offender(source, file, statement, exportedName, STALE_TSDOC_REASON));
          }
          continue;
        }

        if (ts.isFunctionDeclaration(declaration)) {
          offenders.push(offender(source, file, statement, exportedName, MISSING_MARK_DEPRECATED_REASON));
          continue;
        }

        const metadata = deprecationMetadata(declaration);
        if (metadata !== undefined && !isTaggedErrorClass(declaration)) {
          offenders.push(
            offender(source, file, statement, exportedName, INVALID_DEPRECATION_METADATA_REASON),
          );
        } else if (!hasTaggedErrorDeprecationMetadata(declaration)) {
          offenders.push(
            offender(source, file, statement, exportedName, MISSING_DEPRECATION_METADATA_REASON),
          );
        } else if (
          !tsdocMatchesNotice(
            deprecatedTagText(tagNode),
            noticeTextFromExpression(metadata?.initializer, notices),
          )
        ) {
          offenders.push(offender(source, file, statement, exportedName, STALE_TSDOC_REASON));
        }
      }
    }
  }

  return offenders;
};

export const checkDeprecationTsdoc = async (
  options: CheckDeprecationTsdocOptions = {},
): Promise<DeprecationTsdocResult> => {
  const root = resolve(options.root ?? repoRoot);
  const files = (
    await Promise.all(SCANNED_ROOTS.map((scannedRoot) => collectTsFiles(resolve(root, scannedRoot))))
  )
    .flat()
    .sort();

  const offenders = (await Promise.all(files.map((file) => scanFile(file))))
    .flat()
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: DeprecationTsdocOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.exportName}: ${offender.reason}`;

if (import.meta.main) {
  const result = await checkDeprecationTsdoc({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Deprecation TSDoc check passed.\n");
  } else {
    process.stderr.write(
      `Deprecation TSDoc check failed. Public @deprecated exports must record runtime deprecations via markDeprecated() or tagged-error metadata.\n${result.offenders
        .map((entry) => formatOffender(repoRoot, entry))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
