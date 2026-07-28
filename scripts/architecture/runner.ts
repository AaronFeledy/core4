import { resolve } from "node:path";

import { createModuleEdgeCache } from "./edges.ts";
import {
  ARCHITECTURE_EXCEPTIONS,
  applyExceptions,
  auditExceptions,
  defaultRepoRoot,
  shouldAuditExceptions,
} from "./exceptions.ts";
import { createInventory } from "./inventory.ts";
import { createWorkspaceManifestReader } from "./manifests.ts";
import { createSourceFileCache } from "./parse.ts";
import { getRules } from "./registry.ts";
import type {
  ArchitectureRuleId,
  Diagnostic,
  InventoryFile,
  RuleContext,
  RunArchitectureChecks,
} from "./types.ts";

export const runArchitectureChecks: RunArchitectureChecks = async (options) => {
  const root = resolve(options.root);
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot());
  const inventory = createInventory(root);
  const parser = createSourceFileCache();
  const edges = createModuleEdgeCache();
  const manifests = createWorkspaceManifestReader(root, () => inventory.manifestFiles());
  const sourceTexts = new Map<string, Promise<string>>();
  const scannedFiles = new Map<string, InventoryFile>();
  const rules = options.rules ?? getRules(options.ruleIds);
  if (rules.length === 0) {
    throw new TypeError("Architecture run selected no rules; a run with nothing to check cannot pass.");
  }

  const sourceText = (file: InventoryFile): Promise<string> => {
    const cached = sourceTexts.get(file.absolutePath);
    if (cached !== undefined) return cached;
    const text = Bun.file(file.absolutePath).text();
    sourceTexts.set(file.absolutePath, text);
    return text;
  };

  const context: RuleContext = {
    root,
    async files(selector) {
      const files = await inventory.files(selector);
      for (const file of files) scannedFiles.set(file.absolutePath, file);
      return files;
    },
    sourceText,
    async sourceFile(file) {
      return parser.sourceFile(file.absolutePath, await sourceText(file));
    },
    async moduleEdges(file) {
      return edges.moduleEdges(file.absolutePath, await sourceText(file));
    },
    manifests: () => manifests.manifests(),
  };

  const rawDiagnostics: Diagnostic[] = [];
  for (const rule of rules) rawDiagnostics.push(...(await rule.run(context)));

  const application = applyExceptions(rawDiagnostics, ARCHITECTURE_EXCEPTIONS);
  const audit =
    options.auditExceptions === true ||
    (options.auditExceptions !== false && shouldAuditExceptions(root, repoRoot));
  const activeRuleIds = rules.map((rule) => rule.id);
  const staleExceptions = audit
    ? await auditExceptions(root, ARCHITECTURE_EXCEPTIONS, application.usedExceptions, activeRuleIds)
    : [];
  const byRule = new Map<ArchitectureRuleId, ReadonlyArray<Diagnostic>>();
  for (const rule of rules) {
    byRule.set(
      rule.id,
      application.diagnostics.filter((diagnostic) => diagnostic.ruleId === rule.id),
    );
  }
  if (scannedFiles.size === 0) {
    for (const file of await inventory.files("workspace-runtime-sources")) {
      scannedFiles.set(file.absolutePath, file);
    }
  }

  return {
    ok: application.diagnostics.length === 0 && staleExceptions.length === 0,
    diagnostics: application.diagnostics,
    byRule,
    staleExceptions,
    filesScanned: scannedFiles.size,
  };
};
