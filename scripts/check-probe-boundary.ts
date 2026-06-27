import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";

export interface ProbeBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface ProbeBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<ProbeBoundaryOffender>;
}

interface CheckProbeBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "plugins"] as const;

// Pre-existing non-probe retry/Schedule uses are explicitly allowlisted so the
// gate locks the single retry/backoff/verdict primitive (@lando/sdk/probe) for
// host/provider-shaped probing without blocking unrelated synchronization.
const CARVE_OUTS = new Set<string>([
  // Advisory state lockfile acquisition: a bounded retry on O_EXCL contention,
  // not a probe-to-verdict loop.
  "core/src/state/lock.ts",
  // State-bucket lockfile acquisition: same advisory-lock retry shape.
  "core/src/state-store/json-bucket.ts",
]);

// `Effect.<member>(...)` calls that are hand-rolled retry/backoff primitives.
const FORBIDDEN_EFFECT_MEMBERS = new Set(["retry", "repeat", "schedule"]);

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

type ForbiddenExport =
  | { readonly kind: "effect-ns" }
  | { readonly kind: "schedule-ns" }
  | { readonly kind: "effect-member"; readonly member: string }
  | { readonly kind: "schedule-member"; readonly member: string };

interface ModuleProbeBindings {
  readonly effectAliases: ReadonlySet<string>;
  readonly scheduleAliases: ReadonlySet<string>;
  readonly effectMemberAliases: ReadonlyMap<string, string>;
  readonly scheduleMemberAliases: ReadonlyMap<string, string>;
  readonly exports: ReadonlyMap<string, ForbiddenExport>;
}

const emptyModuleProbeBindings = (): ModuleProbeBindings => ({
  effectAliases: new Set(["Effect"]),
  scheduleAliases: new Set(["Schedule"]),
  effectMemberAliases: new Map(),
  scheduleMemberAliases: new Map(),
  exports: new Map(),
});

const bindingFromEffectImport = (moduleName: string, imported: string): ForbiddenExport | undefined => {
  if (moduleName === "effect" && imported === "Effect") return { kind: "effect-ns" };
  if (moduleName === "effect" && imported === "Schedule") return { kind: "schedule-ns" };
  if (moduleName === "effect/Effect" && FORBIDDEN_EFFECT_MEMBERS.has(imported)) {
    return { kind: "effect-member", member: imported };
  }
  if (moduleName === "effect/Schedule") return { kind: "schedule-member", member: imported };
  return undefined;
};

const applyBindingToImportMaps = (
  local: string,
  binding: ForbiddenExport,
  effectAliases: Set<string>,
  scheduleAliases: Set<string>,
  effectMemberAliases: Map<string, string>,
  scheduleMemberAliases: Map<string, string>,
): void => {
  switch (binding.kind) {
    case "effect-ns":
      effectAliases.add(local);
      return;
    case "schedule-ns":
      scheduleAliases.add(local);
      return;
    case "effect-member":
      effectMemberAliases.set(local, binding.member);
      return;
    case "schedule-member":
      scheduleMemberAliases.set(local, binding.member);
      return;
    default:
      return;
  }
};

const analyzeModuleBindings = (
  source: ts.SourceFile,
  resolveRelativeExport: (fromFile: string, moduleSpecifier: string) => ModuleProbeBindings | undefined,
): ModuleProbeBindings => {
  const effectAliases = new Set<string>(["Effect"]);
  const scheduleAliases = new Set<string>(["Schedule"]);
  const effectMemberAliases = new Map<string, string>();
  const scheduleMemberAliases = new Map<string, string>();
  const exports = new Map<string, ForbiddenExport>();
  const localImportBindings = new Map<string, ForbiddenExport>();

  const registerExport = (exportedName: string, binding: ForbiddenExport): void => {
    exports.set(exportedName, binding);
  };

  const handleEffectModuleImport = (moduleName: string, imported: string, local: string): void => {
    const binding = bindingFromEffectImport(moduleName, imported);
    if (binding === undefined) return;
    applyBindingToImportMaps(
      local,
      binding,
      effectAliases,
      scheduleAliases,
      effectMemberAliases,
      scheduleMemberAliases,
    );
    localImportBindings.set(local, binding);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause !== undefined && clause.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
        const bindings = clause.namedBindings;
        if (bindings !== undefined) {
          if (ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              const imported = element.propertyName?.text ?? element.name.text;
              const local = element.name.text;
              if (moduleName.startsWith(".") || moduleName.startsWith("/")) {
                const resolved = resolveRelativeExport(source.fileName, moduleName);
                if (resolved !== undefined) {
                  const binding = resolved.exports.get(imported);
                  if (binding !== undefined) {
                    applyBindingToImportMaps(
                      local,
                      binding,
                      effectAliases,
                      scheduleAliases,
                      effectMemberAliases,
                      scheduleMemberAliases,
                    );
                    localImportBindings.set(local, binding);
                  }
                }
                continue;
              }
              handleEffectModuleImport(moduleName, imported, local);
            }
          } else if (ts.isNamespaceImport(bindings)) {
            if (moduleName === "effect") effectAliases.add(bindings.name.text);
            if (moduleName === "effect/Effect") effectAliases.add(bindings.name.text);
            if (moduleName === "effect/Schedule") scheduleAliases.add(bindings.name.text);
          }
        }
      }
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const moduleName = node.moduleSpecifier.text;
      const exportClause = node.exportClause;
      if (exportClause === undefined) {
        if (moduleName.startsWith(".") || moduleName.startsWith("/")) {
          const resolved = resolveRelativeExport(source.fileName, moduleName);
          if (resolved !== undefined) {
            for (const [exported, binding] of resolved.exports) {
              registerExport(exported, binding);
            }
          }
        }
      } else if (ts.isNamedExports(exportClause)) {
        for (const element of exportClause.elements) {
          const exported = element.name.text;
          const imported = element.propertyName?.text ?? element.name.text;
          if (moduleName.startsWith(".") || moduleName.startsWith("/")) {
            const resolved = resolveRelativeExport(source.fileName, moduleName);
            const binding = resolved?.exports.get(imported);
            if (binding !== undefined) registerExport(exported, binding);
            continue;
          }
          const binding = bindingFromEffectImport(moduleName, imported);
          if (binding !== undefined) registerExport(exported, binding);
        }
      }
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier === undefined &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        const exported = element.name.text;
        const local = element.propertyName?.text ?? element.name.text;
        const binding = localImportBindings.get(local);
        if (binding !== undefined) registerExport(exported, binding);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return {
    effectAliases,
    scheduleAliases,
    effectMemberAliases,
    scheduleMemberAliases,
    exports,
  };
};

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

const registerDestructuredNamespaceMembers = (
  pattern: ts.ObjectBindingPattern,
  namespaceKind: "effect" | "schedule",
  effectLocal: Map<string, string>,
  scheduleLocal: Map<string, string>,
): void => {
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
    const member = bindingElementMemberName(element);
    if (member === undefined) continue;
    const local = element.name.text;
    if (namespaceKind === "effect") {
      if (FORBIDDEN_EFFECT_MEMBERS.has(member)) effectLocal.set(local, member);
      continue;
    }
    scheduleLocal.set(local, member);
  }
};

const extendScopeFromVariableDeclaration = (
  declaration: ts.VariableDeclaration,
  effectAliases: ReadonlySet<string>,
  scheduleAliases: ReadonlySet<string>,
  effectLocal: Map<string, string>,
  scheduleLocal: Map<string, string>,
): void => {
  const initializer = declaration.initializer;
  if (initializer === undefined || !ts.isObjectBindingPattern(declaration.name)) return;
  if (ts.isIdentifier(initializer) && effectAliases.has(initializer.text)) {
    registerDestructuredNamespaceMembers(declaration.name, "effect", effectLocal, scheduleLocal);
    return;
  }
  if (ts.isIdentifier(initializer) && scheduleAliases.has(initializer.text)) {
    registerDestructuredNamespaceMembers(declaration.name, "schedule", effectLocal, scheduleLocal);
  }
};

const scanFileWithBindings = (
  file: string,
  source: ts.SourceFile,
  bindings: ModuleProbeBindings,
): ReadonlyArray<ProbeBoundaryOffender> => {
  const offenders: ProbeBoundaryOffender[] = [];
  const { effectAliases, scheduleAliases, effectMemberAliases, scheduleMemberAliases } = bindings;

  const record = (node: ts.Node, match: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    offenders.push({ file, line: line + 1, match });
  };

  const isEffectAliasIdentifier = (node: ts.Identifier): boolean => effectAliases.has(node.text);

  const visitStatements = (
    statements: ReadonlyArray<ts.Statement>,
    effectLocal: Map<string, string>,
    scheduleLocal: Map<string, string>,
  ): void => {
    const scopeEffectLocal = new Map(effectLocal);
    const scopeScheduleLocal = new Map(scheduleLocal);
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          extendScopeFromVariableDeclaration(
            declaration,
            effectAliases,
            scheduleAliases,
            scopeEffectLocal,
            scopeScheduleLocal,
          );
        }
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.initializer !== undefined) {
            visit(declaration.initializer, scopeEffectLocal, scopeScheduleLocal);
          }
        }
        continue;
      }
      visit(statement, scopeEffectLocal, scopeScheduleLocal);
    }
  };

  const visitForInitializer = (
    initializer: ts.ForInitializer | undefined,
    effectLocal: Map<string, string>,
    scheduleLocal: Map<string, string>,
  ): void => {
    if (initializer === undefined) return;
    if (ts.isVariableDeclarationList(initializer)) {
      const scopeEffect = new Map(effectLocal);
      const scopeSchedule = new Map(scheduleLocal);
      for (const declaration of initializer.declarations) {
        extendScopeFromVariableDeclaration(
          declaration,
          effectAliases,
          scheduleAliases,
          scopeEffect,
          scopeSchedule,
        );
      }
      for (const declaration of initializer.declarations) {
        if (declaration.initializer !== undefined) {
          visit(declaration.initializer, scopeEffect, scopeSchedule);
        }
      }
      return;
    }
    visit(initializer, effectLocal, scheduleLocal);
  };

  const visit = (
    node: ts.Node,
    effectLocal: Map<string, string>,
    scheduleLocal: Map<string, string>,
  ): void => {
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      visitStatements(node.statements, effectLocal, scheduleLocal);
      return;
    }

    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      visitStatements(node.statements, effectLocal, scheduleLocal);
      return;
    }

    if (ts.isForStatement(node)) {
      visitForInitializer(node.initializer, effectLocal, scheduleLocal);
      const scopeEffect = new Map(effectLocal);
      const scopeSchedule = new Map(scheduleLocal);
      if (node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          extendScopeFromVariableDeclaration(
            declaration,
            effectAliases,
            scheduleAliases,
            scopeEffect,
            scopeSchedule,
          );
        }
      }
      if (node.condition !== undefined) visit(node.condition, scopeEffect, scopeSchedule);
      if (node.incrementor !== undefined) visit(node.incrementor, scopeEffect, scopeSchedule);
      visit(node.statement, scopeEffect, scopeSchedule);
      return;
    }

    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;

      if (ts.isIdentifier(node.expression)) {
        const object = node.expression.text;

        if (effectAliases.has(object) && FORBIDDEN_EFFECT_MEMBERS.has(member)) {
          record(node, `Effect.${member}`);
        }

        if (scheduleAliases.has(object)) {
          record(node, `Schedule.${member}`);
        }
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        isEffectAliasIdentifier(node.expression.expression) &&
        node.expression.name.text === "Schedule"
      ) {
        record(node, `Schedule.${member}`);
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      const effectMember = effectMemberAliases.get(callee) ?? effectLocal.get(callee);
      if (effectMember !== undefined) record(node.expression, `Effect.${effectMember}`);

      const scheduleMember = scheduleMemberAliases.get(callee) ?? scheduleLocal.get(callee);
      if (scheduleMember !== undefined) record(node.expression, `Schedule.${scheduleMember}`);
    }

    ts.forEachChild(node, (child) => visit(child, effectLocal, scheduleLocal));
  };

  visit(source, new Map(), new Map());
  return offenders;
};

const resolveTypeScriptModulePath = (fromFile: string, moduleSpecifier: string): string | undefined => {
  if (!moduleSpecifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), moduleSpecifier);
  const candidates = [`${base}.ts`, join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const exportMapsEqual = (
  left: ReadonlyMap<string, ForbiddenExport>,
  right: ReadonlyMap<string, ForbiddenExport>,
): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined) return false;
    if (value.kind !== other.kind) return false;
    if (value.kind === "effect-member" && other.kind === "effect-member" && value.member !== other.member) {
      return false;
    }
    if (
      value.kind === "schedule-member" &&
      other.kind === "schedule-member" &&
      value.member !== other.member
    ) {
      return false;
    }
  }
  return true;
};

const setEqual = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
};

const stringMapEqual = (left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
};

const moduleBindingsEqual = (left: ModuleProbeBindings, right: ModuleProbeBindings): boolean =>
  exportMapsEqual(left.exports, right.exports) &&
  setEqual(left.effectAliases, right.effectAliases) &&
  setEqual(left.scheduleAliases, right.scheduleAliases) &&
  stringMapEqual(left.effectMemberAliases, right.effectMemberAliases) &&
  stringMapEqual(left.scheduleMemberAliases, right.scheduleMemberAliases);

const computeModuleBindings = (
  files: ReadonlyArray<string>,
  sources: ReadonlyMap<string, ts.SourceFile>,
): Map<string, ModuleProbeBindings> => {
  const cache = new Map<string, ModuleProbeBindings>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of files) {
      const source = sources.get(file);
      if (source === undefined) continue;
      const next = analyzeModuleBindings(source, (fromFile, moduleSpecifier) => {
        const resolved = resolveTypeScriptModulePath(fromFile, moduleSpecifier);
        if (resolved === undefined || !sources.has(resolved)) return undefined;
        return cache.get(resolved) ?? emptyModuleProbeBindings();
      });
      const prev = cache.get(file);
      if (prev === undefined || !moduleBindingsEqual(prev, next)) {
        cache.set(file, next);
        changed = true;
      }
    }
  }
  return cache;
};

export const checkProbeBoundary = async (
  options: CheckProbeBoundaryOptions = {},
): Promise<ProbeBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const files = (
    await Promise.all(SCANNED_ROOTS.map((scannedRoot) => collectTsFiles(resolve(root, scannedRoot))))
  )
    .flat()
    .sort();

  const sources = new Map<string, ts.SourceFile>();
  await Promise.all(
    files.map(async (file) => {
      const sourceText = await Bun.file(file).text();
      sources.set(
        file,
        ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      );
    }),
  );

  const moduleCache = computeModuleBindings(files, sources);
  const offenders = files
    .flatMap((file) => {
      const relativeFile = relative(root, file).replaceAll("\\", "/");
      if (CARVE_OUTS.has(relativeFile)) return [];
      const source = sources.get(file);
      if (source === undefined) return [];
      const bindings = moduleCache.get(file) ?? emptyModuleProbeBindings();
      return scanFileWithBindings(file, source, bindings);
    })
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: ProbeBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkProbeBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Probe boundary check passed.\n");
  } else {
    process.stderr.write(
      `Probe boundary check failed. Host/provider-shaped retry/backoff/timeout-to-verdict probing must build on @lando/sdk/probe (runProbe), not hand-rolled Effect.retry/repeat/schedule or Schedule loops.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
