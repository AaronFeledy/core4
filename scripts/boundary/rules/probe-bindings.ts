import ts from "typescript";

export const FORBIDDEN_EFFECT_MEMBERS: ReadonlySet<string> = new Set(["retry", "repeat", "schedule"]);

export type ForbiddenProbeExport =
  | { readonly kind: "effect-ns" }
  | { readonly kind: "schedule-ns" }
  | { readonly kind: "effect-member"; readonly member: string }
  | { readonly kind: "schedule-member"; readonly member: string };

export interface ModuleProbeBindings {
  readonly effectAliases: ReadonlySet<string>;
  readonly scheduleAliases: ReadonlySet<string>;
  readonly effectMemberAliases: ReadonlyMap<string, string>;
  readonly scheduleMemberAliases: ReadonlyMap<string, string>;
  readonly exports: ReadonlyMap<string, ForbiddenProbeExport>;
}

export const emptyModuleProbeBindings = (): ModuleProbeBindings => ({
  effectAliases: new Set(["Effect"]),
  scheduleAliases: new Set(["Schedule"]),
  effectMemberAliases: new Map(),
  scheduleMemberAliases: new Map(),
  exports: new Map(),
});

const bindingFromEffectImport = (moduleName: string, imported: string): ForbiddenProbeExport | undefined => {
  if (moduleName === "effect" && imported === "Effect") return { kind: "effect-ns" };
  if (moduleName === "effect" && imported === "Schedule") return { kind: "schedule-ns" };
  if (moduleName === "effect/Effect" && FORBIDDEN_EFFECT_MEMBERS.has(imported)) {
    return { kind: "effect-member", member: imported };
  }
  if (moduleName === "effect/Schedule") return { kind: "schedule-member", member: imported };
  return undefined;
};

interface ImportMaps {
  readonly effectAliases: Set<string>;
  readonly scheduleAliases: Set<string>;
  readonly effectMemberAliases: Map<string, string>;
  readonly scheduleMemberAliases: Map<string, string>;
}

const applyBindingToImportMaps = (local: string, binding: ForbiddenProbeExport, maps: ImportMaps): void => {
  switch (binding.kind) {
    case "effect-ns":
      maps.effectAliases.add(local);
      return;
    case "schedule-ns":
      maps.scheduleAliases.add(local);
      return;
    case "effect-member":
      maps.effectMemberAliases.set(local, binding.member);
      return;
    case "schedule-member":
      maps.scheduleMemberAliases.set(local, binding.member);
      return;
  }
};

type ResolveRelativeExport = (fromFile: string, moduleSpecifier: string) => ModuleProbeBindings | undefined;

export const analyzeModuleBindings = (
  source: ts.SourceFile,
  resolveRelativeExport: ResolveRelativeExport,
): ModuleProbeBindings => {
  const maps: ImportMaps = {
    effectAliases: new Set(["Effect"]),
    scheduleAliases: new Set(["Schedule"]),
    effectMemberAliases: new Map(),
    scheduleMemberAliases: new Map(),
  };
  const exports = new Map<string, ForbiddenProbeExport>();
  const localImportBindings = new Map<string, ForbiddenProbeExport>();

  const registerImport = (local: string, binding: ForbiddenProbeExport): void => {
    applyBindingToImportMaps(local, binding, maps);
    localImportBindings.set(local, binding);
  };

  const visitImport = (node: ts.ImportDeclaration): void => {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const moduleName = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      if (moduleName === "effect" || moduleName === "effect/Effect") {
        maps.effectAliases.add(bindings.name.text);
      }
      if (moduleName === "effect/Schedule") maps.scheduleAliases.add(bindings.name.text);
      return;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const local = element.name.text;
      if (moduleName.startsWith(".") || moduleName.startsWith("/")) {
        const binding = resolveRelativeExport(source.fileName, moduleName)?.exports.get(imported);
        if (binding !== undefined) registerImport(local, binding);
        continue;
      }
      const binding = bindingFromEffectImport(moduleName, imported);
      if (binding !== undefined) registerImport(local, binding);
    }
  };

  const visitExternalExport = (node: ts.ExportDeclaration, moduleName: string): void => {
    const exportClause = node.exportClause;
    if (exportClause === undefined) {
      if (!moduleName.startsWith(".") && !moduleName.startsWith("/")) return;
      const resolved = resolveRelativeExport(source.fileName, moduleName);
      if (resolved === undefined) return;
      for (const [exported, binding] of resolved.exports) exports.set(exported, binding);
      return;
    }
    if (!ts.isNamedExports(exportClause)) return;
    for (const element of exportClause.elements) {
      const exported = element.name.text;
      const imported = element.propertyName?.text ?? element.name.text;
      const binding =
        moduleName.startsWith(".") || moduleName.startsWith("/")
          ? resolveRelativeExport(source.fileName, moduleName)?.exports.get(imported)
          : bindingFromEffectImport(moduleName, imported);
      if (binding !== undefined) exports.set(exported, binding);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) visitImport(node);
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        visitExternalExport(node, node.moduleSpecifier.text);
      } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const exported = element.name.text;
          const local = element.propertyName?.text ?? element.name.text;
          const binding = localImportBindings.get(local);
          if (binding !== undefined) exports.set(exported, binding);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return { ...maps, exports };
};

const exportMapsEqual = (
  left: ReadonlyMap<string, ForbiddenProbeExport>,
  right: ReadonlyMap<string, ForbiddenProbeExport>,
): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined || value.kind !== other.kind) return false;
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
  for (const value of left) if (!right.has(value)) return false;
  return true;
};

const stringMapEqual = (left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
};

export const moduleBindingsEqual = (left: ModuleProbeBindings, right: ModuleProbeBindings): boolean =>
  exportMapsEqual(left.exports, right.exports) &&
  setEqual(left.effectAliases, right.effectAliases) &&
  setEqual(left.scheduleAliases, right.scheduleAliases) &&
  stringMapEqual(left.effectMemberAliases, right.effectMemberAliases) &&
  stringMapEqual(left.scheduleMemberAliases, right.scheduleMemberAliases);
