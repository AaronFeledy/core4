import type { Effect } from "effect";

import type { LandofileExpressionParseError, ToolingStepConditionError } from "@lando/sdk/errors";
import type { ExpressionContext, LandofileExpressionEvaluationError } from "@lando/sdk/expressions";
import type { PortablePath, ToolingVarLiteral } from "@lando/sdk/schema";

import type { ToolingStepLeaf } from "./step-program.ts";

interface ResolvedLeafBase {
  readonly authoredIndex: number;
  readonly silent: boolean;
  readonly ignoreError: boolean;
}

export interface ResolvedToolingCmdStepLeaf extends ResolvedLeafBase {
  readonly kind: "cmd";
  readonly command: string;
  readonly service?: string;
  readonly env?: Readonly<Record<string, ToolingVarLiteral>>;
  readonly user?: string;
  readonly dir?: PortablePath;
}

export interface ResolvedToolingTaskStepLeaf extends ResolvedLeafBase {
  readonly kind: "task";
  readonly task: string;
  readonly vars: Readonly<Record<string, unknown>>;
}

export interface ResolvedToolingCommandStepLeaf extends ResolvedLeafBase {
  readonly kind: "command";
  readonly command: string;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly raw: ReadonlyArray<string>;
}

export type ResolvedToolingStepLeaf =
  | ResolvedToolingCmdStepLeaf
  | ResolvedToolingTaskStepLeaf
  | ResolvedToolingCommandStepLeaf;

export interface ToolingStepPresentation<A> {
  readonly leaf: ResolvedToolingStepLeaf;
  readonly context: ExpressionContext;
  readonly result: A;
}

export interface ToolingStepRunners<E, A> {
  readonly runCmd: (leaf: ResolvedToolingCmdStepLeaf, context: ExpressionContext) => Effect.Effect<A, E>;
  readonly runTask: (leaf: ResolvedToolingTaskStepLeaf, context: ExpressionContext) => Effect.Effect<A, E>;
  readonly runCommand: (
    leaf: ResolvedToolingCommandStepLeaf,
    context: ExpressionContext,
  ) => Effect.Effect<A, E>;
  readonly present: (presentation: ToolingStepPresentation<A>) => Effect.Effect<void, E>;
  readonly mapLeafError?: (leaf: ToolingStepLeaf, error: unknown) => E;
}

export type ToolingStepExpressionError = LandofileExpressionParseError | LandofileExpressionEvaluationError;
export type ToolingStepRunError<E> = E | ToolingStepConditionError | ToolingStepExpressionError;
