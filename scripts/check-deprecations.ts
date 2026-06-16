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

export interface DeprecationReleaseOffender {
  readonly file: string;
  readonly line: number;
  readonly exportName: string;
  readonly reason: string;
  readonly removeIn?: string;
  readonly expectedAction?: string;
}

export interface DeprecationReleaseResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<DeprecationReleaseOffender>;
}

interface CheckDeprecationTsdocOptions {
  readonly root?: string;
}

interface CheckDeprecationReleaseGateOptions {
  readonly root?: string;
  readonly releasedOrPending?: ReadonlyArray<string>;
  readonly targetRelease?: string;
  readonly today?: Date;
  readonly env?: NodeJS.ProcessEnv;
}

const repoRoot = resolve(import.meta.dirname, "..");
const SCANNED_ROOTS = ["sdk/src", "core/src", "plugins"] as const;
const MISSING_MARK_DEPRECATED_REASON = "missing markDeprecated(notice, impl) wrapper";
const MISMATCHED_MARK_DEPRECATED_ID_REASON = "markDeprecated export id must match exported name";
const MISSING_DEPRECATION_METADATA_REASON = "missing static readonly deprecation metadata";
const STALE_TSDOC_REASON = "@deprecated text must include DeprecationNotice note/replacement";
const INVALID_DEPRECATION_METADATA_REASON =
  "static readonly deprecation metadata is only accepted on tagged errors";
const INVALID_SINCE_REASON = "since must match a released or pending semver";
const MISSING_REMOVE_IN_REASON = "removeIn is required for notices older than 12 months";
const INVALID_REMOVE_IN_REASON = "removeIn must be a future major or minor release";
const DEFAULT_RELEASED_OR_PENDING = ["4.0.0", "4.1.0", "4.2.0", "5.0.0"] as const;
const DEFAULT_TARGET_RELEASE = "4.0.0";
const DEVELOPMENT_PACKAGE_VERSION = "0.0.0";
const RELEASE_DATES = new Map<string, Date>([
  ["4.0.0", new Date("2024-06-01T00:00:00Z")],
  ["4.1.0", new Date("2025-01-01T00:00:00Z")],
  ["4.2.0", new Date("2026-01-01T00:00:00Z")],
  ["5.0.0", new Date("2027-01-01T00:00:00Z")],
]);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

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

interface MarkDeprecatedImportBindings {
  readonly named: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
}

const markDeprecatedImportBindings = (source: ts.SourceFile): MarkDeprecatedImportBindings => {
  const named = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings === undefined) continue;

    if (ts.isNamespaceImport(namedBindings)) {
      namespaces.add(namedBindings.name.text);
      continue;
    }

    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue;
      if ((element.propertyName?.text ?? element.name.text) === "markDeprecated") {
        named.add(element.name.text);
      }
    }
  }

  return { named, namespaces };
};

const isMarkDeprecatedCall = (
  expression: ts.Expression | undefined,
  importedBindings: MarkDeprecatedImportBindings,
): boolean => {
  if (expression === undefined || !ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  if (ts.isIdentifier(callee)) return importedBindings.named.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    return (
      propertyNameText(callee.name) === "markDeprecated" &&
      ts.isIdentifier(callee.expression) &&
      importedBindings.namespaces.has(callee.expression.text)
    );
  }
  return false;
};

const markDeprecatedExportId = (
  expression: ts.Expression | undefined,
  importedBindings: MarkDeprecatedImportBindings,
): string | undefined => {
  if (
    expression === undefined ||
    !ts.isCallExpression(expression) ||
    !isMarkDeprecatedCall(expression, importedBindings)
  ) {
    return undefined;
  }

  const explicitId = stringLiteralValue(expression.arguments[1]);
  if (explicitId !== undefined) return expression.arguments[2] === undefined ? undefined : explicitId;

  const impl = expression.arguments[1];
  if (impl === undefined) return undefined;
  if (ts.isFunctionExpression(impl) && impl.name !== undefined) {
    return impl.name.text;
  }
  return undefined;
};

const markDeprecatedTracksExport = (
  expression: ts.Expression | undefined,
  exportName: string,
  importedBindings: MarkDeprecatedImportBindings,
): boolean => markDeprecatedExportId(expression, importedBindings) === exportName;

interface NoticeText {
  readonly since?: string;
  readonly removeIn?: string;
  readonly note?: string;
  readonly replacement?: string;
}

interface ReleaseNotice {
  readonly since: string;
  readonly removeIn?: string;
}

interface ReleaseNoticeUse {
  readonly file: string;
  readonly line: number;
  readonly exportName: string;
  readonly notice: ReleaseNotice;
}

export class DeprecationStaleError extends Error {
  constructor(readonly removeIn: string) {
    super(`DeprecationStaleError: surface is still present at removeIn ${removeIn}`);
    this.name = "DeprecationStaleError";
  }
}

export class DeprecationOverdueError extends Error {
  constructor(readonly removeIn: string) {
    super(`DeprecationOverdueError: surface is still present after removeIn ${removeIn}`);
    this.name = "DeprecationOverdueError";
  }
}

const parseSemver = (value: string): Semver | undefined => {
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
};

const compareSemver = (left: Semver, right: Semver): number => {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
};

const semverCompare = (left: string, right: string): number => {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (parsedLeft === undefined || parsedRight === undefined) return left.localeCompare(right);
  return compareSemver(parsedLeft, parsedRight);
};
const normalizeReleaseVersion = (value: string | undefined): string | undefined => {
  if (value === undefined || value === "") return undefined;
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:[-+].*)?$/.exec(value);
  return match?.[1];
};

const packageTargetRelease = async (root: string): Promise<string | undefined> => {
  try {
    const packageJson = (await Bun.file(resolve(root, "package.json")).json()) as { version?: unknown };
    const version =
      typeof packageJson.version === "string" ? normalizeReleaseVersion(packageJson.version) : undefined;
    return version === DEVELOPMENT_PACKAGE_VERSION ? undefined : version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const resolveTargetRelease = async (
  root: string,
  options: Pick<CheckDeprecationReleaseGateOptions, "targetRelease" | "env">,
): Promise<string> =>
  normalizeReleaseVersion(options.targetRelease) ??
  normalizeReleaseVersion(options.env?.LANDO_RELEASE_VERSION) ??
  normalizeReleaseVersion(options.env?.LANDO_NPM_VERSION) ??
  (await packageTargetRelease(root)) ??
  DEFAULT_TARGET_RELEASE;

const isTwelveMonthsOld = (since: string, today: Date): boolean => {
  const releaseDate = RELEASE_DATES.get(since);
  if (releaseDate === undefined) return false;
  const elapsedMs = today.getTime() - releaseDate.getTime();
  return elapsedMs >= 365 * 24 * 60 * 60 * 1000;
};

const stringLiteralValue = (expression: ts.Expression | undefined): string | undefined => {
  if (expression === undefined) return undefined;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return expression.text;
  return undefined;
};

const noticeTextFromObjectLiteral = (expression: ts.Expression | undefined): NoticeText | undefined => {
  if (expression === undefined || !ts.isObjectLiteralExpression(expression)) return undefined;
  const notice: { since?: string; removeIn?: string; note?: string; replacement?: string } = {};
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (name === "since") notice.since = stringLiteralValue(property.initializer);
    if (name === "removeIn") notice.removeIn = stringLiteralValue(property.initializer);
    if (name === "note") notice.note = stringLiteralValue(property.initializer);
    if (name === "replacement") notice.replacement = stringLiteralValue(property.initializer);
  }
  return notice.since === undefined &&
    notice.removeIn === undefined &&
    notice.note === undefined &&
    notice.replacement === undefined
    ? undefined
    : notice;
};

const releaseNoticeFromNoticeText = (notice: NoticeText | undefined): ReleaseNotice | undefined => {
  if (notice?.since === undefined) return undefined;
  return { since: notice.since, removeIn: notice.removeIn };
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
  const markDeprecatedBindings = markDeprecatedImportBindings(source);
  const localDeclarations = new Map<
    string,
    ts.VariableDeclaration | ts.FunctionDeclaration | ts.ClassDeclaration
  >();
  const localTypeDeclarations = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();

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
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      localTypeDeclarations.set(statement.name.text, statement);
    }
  }

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement) && hasDeprecatedTag(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const exportName = propertyNameText(declaration.name) ?? "<destructured>";
        if (!isMarkDeprecatedCall(declaration.initializer, markDeprecatedBindings)) {
          offenders.push(offender(source, file, statement, exportName, MISSING_MARK_DEPRECATED_REASON));
        } else if (!markDeprecatedTracksExport(declaration.initializer, exportName, markDeprecatedBindings)) {
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
      if (statement.isTypeOnly) continue;

      const exportTagged = hasDeprecatedTag(statement);
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;

        const exportedName = element.name.text;
        const localName = element.propertyName?.text ?? exportedName;
        const declaration = localDeclarations.get(localName);
        if (declaration === undefined && localTypeDeclarations.has(localName)) continue;

        const localTagNode = declaration === undefined ? undefined : localDeclarationTagNode(declaration);
        const localTagged = localTagNode !== undefined && hasDeprecatedTag(localTagNode);
        if (!exportTagged && !localTagged) continue;
        const tagNode = exportTagged ? statement : (localTagNode as ts.Node);

        if (declaration === undefined) {
          offenders.push(offender(source, file, statement, exportedName, MISSING_MARK_DEPRECATED_REASON));
          continue;
        }

        if (ts.isVariableDeclaration(declaration)) {
          if (!isMarkDeprecatedCall(declaration.initializer, markDeprecatedBindings)) {
            offenders.push(offender(source, file, statement, exportedName, MISSING_MARK_DEPRECATED_REASON));
          } else if (
            !markDeprecatedTracksExport(declaration.initializer, exportedName, markDeprecatedBindings)
          ) {
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

const releaseUse = (
  source: ts.SourceFile,
  file: string,
  node: ts.Node,
  exportName: string,
  notice: ReleaseNotice | undefined,
): ReleaseNoticeUse | undefined => {
  if (notice === undefined) return undefined;
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file, line: line + 1, exportName, notice };
};

const releaseUseFromRegistryObject = (
  source: ts.SourceFile,
  file: string,
  object: ts.ObjectLiteralExpression,
  bindings: ReadonlyMap<string, NoticeText>,
): ReleaseNoticeUse | undefined => {
  let id: string | undefined;
  let notice: ReleaseNotice | undefined;
  let noticeNode: ts.Node | undefined;

  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (name === "id" || name === "name") id ??= stringLiteralValue(property.initializer);
    if (name === "deprecated") {
      notice = releaseNoticeFromNoticeText(noticeTextFromExpression(property.initializer, bindings));
      noticeNode = property;
    }
  }

  if (notice === undefined) return undefined;
  const { line } = source.getLineAndCharacterOfPosition((noticeNode ?? object).getStart(source));
  return { file, line: line + 1, exportName: id ?? "<deprecated>", notice };
};

const collectRegistryReleaseNotices = (
  source: ts.SourceFile,
  file: string,
  bindings: ReadonlyMap<string, NoticeText>,
): ReadonlyArray<ReleaseNoticeUse> => {
  const uses: ReleaseNoticeUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const use = releaseUseFromRegistryObject(source, file, node, bindings);
      if (use !== undefined) uses.push(use);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
};

const collectReleaseNoticesFromFile = async (file: string): Promise<ReadonlyArray<ReleaseNoticeUse>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const uses: ReleaseNoticeUse[] = [];
  const notices = localNoticeBindings(source);
  const markDeprecatedBindings = markDeprecatedImportBindings(source);
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

  const noticeFromMarkDeprecated = (expression: ts.Expression | undefined): ReleaseNotice | undefined => {
    if (expression === undefined || !ts.isCallExpression(expression)) return undefined;
    if (!isMarkDeprecatedCall(expression, markDeprecatedBindings)) return undefined;
    return releaseNoticeFromNoticeText(noticeTextFromExpression(expression.arguments[0], notices));
  };

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const exportName = propertyNameText(declaration.name) ?? "<destructured>";
        const use = releaseUse(
          source,
          file,
          statement,
          exportName,
          noticeFromMarkDeprecated(declaration.initializer),
        );
        if (use !== undefined) uses.push(use);
      }
      continue;
    }

    if (ts.isClassDeclaration(statement) && hasExportModifier(statement)) {
      const exportName = statement.name?.text ?? "<default>";
      const metadata = deprecationMetadata(statement);
      const use = releaseUse(
        source,
        file,
        statement,
        exportName,
        releaseNoticeFromNoticeText(noticeTextFromExpression(metadata?.initializer, notices)),
      );
      if (use !== undefined) uses.push(use);
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.moduleSpecifier === undefined &&
      !statement.isTypeOnly
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const exportedName = element.name.text;
        const localName = element.propertyName?.text ?? exportedName;
        const declaration = localDeclarations.get(localName);
        if (declaration === undefined) continue;
        if (ts.isVariableDeclaration(declaration)) {
          const use = releaseUse(
            source,
            file,
            statement,
            exportedName,
            noticeFromMarkDeprecated(declaration.initializer),
          );
          if (use !== undefined) uses.push(use);
          continue;
        }
        if (ts.isClassDeclaration(declaration)) {
          const metadata = deprecationMetadata(declaration);
          const use = releaseUse(
            source,
            file,
            statement,
            exportedName,
            releaseNoticeFromNoticeText(noticeTextFromExpression(metadata?.initializer, notices)),
          );
          if (use !== undefined) uses.push(use);
        }
      }
    }
  }

  return [...uses, ...collectRegistryReleaseNotices(source, file, notices)].sort(
    (left, right) => left.line - right.line || left.exportName.localeCompare(right.exportName),
  );
};

const releaseOffender = (
  use: ReleaseNoticeUse,
  reason: string,
  annotations?: { readonly removeIn: string; readonly expectedAction: string },
): DeprecationReleaseOffender => ({
  file: use.file,
  line: use.line,
  exportName: use.exportName,
  reason,
  ...(annotations === undefined
    ? {}
    : { removeIn: annotations.removeIn, expectedAction: annotations.expectedAction }),
});

export const checkDeprecationReleaseGate = async (
  options: CheckDeprecationReleaseGateOptions = {},
): Promise<DeprecationReleaseResult> => {
  const root = resolve(options.root ?? repoRoot);
  const releasedOrPending = new Set(options.releasedOrPending ?? DEFAULT_RELEASED_OR_PENDING);
  const targetRelease = await resolveTargetRelease(root, {
    targetRelease: options.targetRelease,
    env: options.env ?? process.env,
  });
  const today = options.today ?? new Date();
  const files = (
    await Promise.all(SCANNED_ROOTS.map((scannedRoot) => collectTsFiles(resolve(root, scannedRoot))))
  )
    .flat()
    .sort();
  const uses = (await Promise.all(files.map((file) => collectReleaseNoticesFromFile(file))))
    .flat()
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  const offenders: DeprecationReleaseOffender[] = [];

  for (const use of uses) {
    const { notice } = use;
    if (parseSemver(notice.since) === undefined || !releasedOrPending.has(notice.since)) {
      offenders.push(releaseOffender(use, INVALID_SINCE_REASON));
    }
    if (notice.removeIn === undefined && isTwelveMonthsOld(notice.since, today)) {
      offenders.push(releaseOffender(use, MISSING_REMOVE_IN_REASON));
    }
    if (notice.removeIn !== undefined) {
      const since = parseSemver(notice.since);
      const removeIn = parseSemver(notice.removeIn);
      if (
        since === undefined ||
        removeIn === undefined ||
        removeIn.patch !== 0 ||
        compareSemver(removeIn, since) <= 0
      ) {
        offenders.push(releaseOffender(use, INVALID_REMOVE_IN_REASON));
      }
      const releaseComparison = semverCompare(notice.removeIn, targetRelease);
      if (releaseComparison === 0) {
        offenders.push(
          releaseOffender(use, new DeprecationStaleError(notice.removeIn).message, {
            removeIn: notice.removeIn,
            expectedAction: `Remove ${use.exportName} before releasing ${targetRelease}; its removeIn (${notice.removeIn}) has arrived.`,
          }),
        );
      } else if (releaseComparison < 0) {
        offenders.push(
          releaseOffender(use, new DeprecationOverdueError(notice.removeIn).message, {
            removeIn: notice.removeIn,
            expectedAction: `Remove ${use.exportName} before releasing ${targetRelease}; its removeIn (${notice.removeIn}) has passed.`,
          }),
        );
      }
    }
  }

  return { ok: offenders.length === 0, offenders };
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
  const tsdoc = await checkDeprecationTsdoc({ root: repoRoot });
  const release = await checkDeprecationReleaseGate({ root: repoRoot });
  if (tsdoc.ok && release.ok) {
    process.stdout.write("Deprecation check passed.\n");
  } else {
    if (!tsdoc.ok) {
      process.stderr.write(
        `Deprecation TSDoc check failed. Public @deprecated exports must record runtime deprecations via markDeprecated() or tagged-error metadata.\n${tsdoc.offenders
          .map((entry) => formatOffender(repoRoot, entry))
          .join("\n")}\n`,
      );
    }
    if (!release.ok) {
      process.stderr.write(
        `Deprecation release gate failed. Notices must use released/pending since versions, schedule old removals, and remove stale surfaces before release.\n${release.offenders
          .map((entry) => formatOffender(repoRoot, entry))
          .join("\n")}\n`,
      );
    }
    process.exitCode = 1;
  }
}
