import type ts from "typescript";

import type { ModuleEdge } from "../module-edge-scan.ts";

export interface RuleScope {
  readonly roots: readonly string[];
  readonly extensions: readonly string[];
  readonly excludeDirNames?: readonly string[];
  readonly excludePathSegments?: readonly string[];
  readonly excludeTestFiles?: boolean;
  readonly excludeFiles?: readonly string[];
  readonly excludePrefixes?: readonly string[];
}

export interface CarveOuts {
  readonly files: readonly string[];
  readonly prefixes: readonly string[];
  /** Keep carve-outs in `onProgram` analysis while the engine suppresses reports against them. */
  readonly reportOnly?: boolean;
}

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export interface ReportedViolation {
  readonly line: number;
  readonly detail: string;
}

export interface FileRecord {
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface FileContext extends FileRecord {
  readonly sourceFile: Promise<ts.SourceFile>;
  readonly report: (violation: ReportedViolation) => void;
}

export interface ProgramContext {
  readonly root: string;
  readonly files: readonly FileRecord[];
  readonly sourceFile: (file: FileRecord | string) => Promise<ts.SourceFile>;
  readonly text: (file: FileRecord | string) => Promise<string>;
  readonly edges: (file: FileRecord | string) => Promise<readonly ModuleEdge[]>;
  readonly report: (file: string, line: number, detail: string) => void;
}

export interface BoundaryRule {
  readonly id: string;
  readonly scope: RuleScope;
  readonly carveOuts: CarveOuts;
  readonly passMessage: string;
  readonly failureHeadline: string;
  readonly onNode?: (node: ts.Node, context: FileContext) => void;
  readonly onEdges?: (edges: readonly ModuleEdge[], context: FileContext) => void;
  readonly onProgram?: (context: ProgramContext) => void;
}

export interface BoundaryRuleResult {
  readonly ok: boolean;
  readonly violations: readonly Violation[];
}
