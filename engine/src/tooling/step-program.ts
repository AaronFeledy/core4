import type { ExpressionContext } from "@lando/sdk/expressions";
import type { EventCommandInputValue, ToolingVarLiteral } from "@lando/sdk/schema";

export type ToolingStepCondition = boolean | string;

interface ToolingStepLeafBase {
  readonly authoredIndex: number;
  readonly condition?: ToolingStepCondition;
  readonly silent: boolean;
  readonly ignoreError: boolean;
}

export interface ToolingCmdStepLeaf extends ToolingStepLeafBase {
  readonly kind: "cmd";
  readonly command: string;
  readonly service?: string;
  readonly env?: Readonly<Record<string, ToolingVarLiteral>>;
  readonly user?: string;
  readonly dir?: string;
}

export interface ToolingTaskStepLeaf extends ToolingStepLeafBase {
  readonly kind: "task";
  readonly task: string;
  readonly vars?: Readonly<Record<string, ToolingVarLiteral>>;
}

export interface ToolingCommandStepLeaf extends ToolingStepLeafBase {
  readonly kind: "command";
  readonly command: string;
  /** Scalar literals, or homogeneous string arrays for repeatable target inputs. */
  readonly flags: Readonly<Record<string, EventCommandInputValue>>;
  readonly args: Readonly<Record<string, EventCommandInputValue>>;
  readonly raw: ReadonlyArray<string>;
}

export type ToolingStepLeaf = ToolingCmdStepLeaf | ToolingTaskStepLeaf | ToolingCommandStepLeaf;

export type ToolingStepSelector =
  | { readonly kind: "list"; readonly values: ReadonlyArray<ToolingVarLiteral> }
  | { readonly kind: "var"; readonly name: string }
  | {
      readonly kind: "matrix";
      readonly axes: ReadonlyArray<readonly [name: string, values: ReadonlyArray<ToolingVarLiteral>]>;
    };

export interface ToolingStepLeafNode {
  readonly kind: "leaf";
  readonly authoredIndex: number;
  readonly leaf: ToolingStepLeaf;
}

export interface ToolingStepDeferNode {
  readonly kind: "defer";
  readonly authoredIndex: number;
  readonly leaf: ToolingStepLeaf;
}

export interface ToolingStepForNode {
  readonly kind: "for";
  readonly authoredIndex: number;
  readonly selector: ToolingStepSelector;
  readonly body: ToolingStepLeafNode | ToolingStepDeferNode;
}

export type ToolingStepNode = ToolingStepLeafNode | ToolingStepDeferNode | ToolingStepForNode;

export interface ToolingStepProgram {
  readonly nodes: ReadonlyArray<ToolingStepNode>;
}

export interface ToolingStepIteration {
  readonly context: ExpressionContext;
  readonly item: unknown;
  readonly key: string | number;
}
