import type ts from "typescript";

import type { ModuleEdge } from "../module-edge-scan.ts";

export type ArchitectureRuleId =
  | "renderer-boundary"
  | "managed-file-boundary"
  | "redaction-boundary"
  | "env-helper-boundary"
  | "package-dag"
  | "paths-boundary"
  | "state-store-boundary"
  | "probe-boundary"
  | "network-boundary"
  | "import-cycle";

export interface Diagnostic {
  readonly ruleId: ArchitectureRuleId;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
  readonly detail?: ReadonlyArray<string>;
}

export type InventorySelector =
  | "core-and-plugin-sources"
  | "service-lando-services"
  | "workspace-runtime-sources";

export interface InventoryFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export interface RuleContext {
  readonly root: string;
  files(selector: InventorySelector): Promise<ReadonlyArray<InventoryFile>>;
  sourceText(file: InventoryFile): Promise<string>;
  sourceFile(file: InventoryFile): Promise<ts.SourceFile>;
  moduleEdges(file: InventoryFile): Promise<ReadonlyArray<ModuleEdge>>;
  manifests(): Promise<ReadonlyArray<WorkspaceManifest>>;
}

export interface WorkspaceManifest {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly relativeRoot: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly devDependencies: ReadonlyArray<string>;
  readonly peerDependencies: ReadonlyArray<string>;
  readonly exports?: unknown;
  readonly main?: string;
  readonly types?: string;
}

export interface Rule {
  readonly id: ArchitectureRuleId;
  readonly title: string;
  readonly failureHeadline: string;
  run(context: RuleContext): Promise<ReadonlyArray<Diagnostic>>;
}

export type ExceptionCategory = "owner" | "carve-out";
export type ExceptionKind = "file" | "prefix";
export type UnusedPolicy = "error" | "allow";

export interface ArchitectureException {
  readonly ruleId: ArchitectureRuleId;
  readonly path: string;
  readonly kind: ExceptionKind;
  readonly category: ExceptionCategory;
  readonly rationale: string;
  readonly removalCondition: string;
  readonly unusedPolicy?: UnusedPolicy;
  readonly skipMissingAudit?: boolean;
}

export type StalenessKind = "stale-missing" | "stale-unused";

export interface ExceptionStaleness {
  readonly kind: StalenessKind;
  readonly exception: ArchitectureException;
  readonly message: string;
}

export interface RunOptions {
  readonly root: string;
  readonly ruleIds?: ReadonlyArray<ArchitectureRuleId>;
  readonly auditExceptions?: boolean;
  readonly repoRoot?: string;
  readonly rules?: ReadonlyArray<Rule>;
}

export interface RunResult {
  readonly ok: boolean;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly byRule: ReadonlyMap<ArchitectureRuleId, ReadonlyArray<Diagnostic>>;
  readonly staleExceptions: ReadonlyArray<ExceptionStaleness>;
  readonly filesScanned: number;
}

export interface ExceptionApplication {
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly usedExceptions: ReadonlySet<ArchitectureException>;
}

export type ApplyExceptions = (
  diagnostics: ReadonlyArray<Diagnostic>,
  exceptions: ReadonlyArray<ArchitectureException>,
) => ExceptionApplication;

export type AuditExceptions = (
  root: string,
  exceptions: ReadonlyArray<ArchitectureException>,
  usedExceptions: ReadonlySet<ArchitectureException>,
  activeRuleIds?: ReadonlyArray<ArchitectureRuleId>,
) => Promise<ReadonlyArray<ExceptionStaleness>>;

export type RunArchitectureChecks = (options: RunOptions) => Promise<RunResult>;
