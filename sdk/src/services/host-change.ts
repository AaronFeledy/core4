import type { Effect } from "effect";

import type {
  HostChangeContractError,
  HostChangeFailedError,
  HostChangeStaleError,
  PrivilegeError,
} from "../errors/index.ts";
import type { HostChange, HostChangeId, HostChangeOutcome, HostChangeUndo } from "../schema/host-change.ts";
import type { ProcessResult } from "./process.ts";

export type HostChangeApplyError =
  | PrivilegeError
  | HostChangeFailedError
  | HostChangeStaleError
  | HostChangeContractError;

/** Runs the steps one change declared; nothing else. */
export interface HostChangeStepRunner {
  /**
   * Run the declared step `stepId`. Privileged steps go through the run's administrator session.
   * A nonzero exit is the step's `ProcessResult` for the change to judge.
   */
  readonly run: (
    stepId: string,
    options?: { readonly stdin?: Uint8Array },
  ) => Effect.Effect<ProcessResult, PrivilegeError | HostChangeContractError>;
}

export interface HostChangeApplyResult {
  /** False when the host already had the change; nothing ran. */
  readonly changed: boolean;
  /** Facts known only once the change ran, such as the exact range it added. */
  readonly facts?: Readonly<Record<string, string>>;
  /** Replaces the planned undo with one that names exactly what ran. */
  readonly undo?: HostChangeUndo;
}

/** A change a service proposes, read-only, together with how it applies the change. */
export interface HostChangeProposal {
  readonly change: HostChange;
  /**
   * Apply the change with only its declared steps. Fails with `HostChangeStaleError` before
   * running anything when the host no longer matches the plan.
   */
  readonly apply: (steps: HostChangeStepRunner) => Effect.Effect<HostChangeApplyResult, HostChangeApplyError>;
}

/** The approved part of one run's host-change plan, applied at most once per change. */
export interface HostChangeApplier {
  /** The approved change with this id, or undefined when it was not planned or not approved. */
  readonly approved: (id: HostChangeId) => HostChange | undefined;
  /**
   * Apply a planned change once per run; a second call returns the first outcome. A change that
   * was not approved is `declined` and runs nothing.
   */
  readonly apply: (id: HostChangeId) => Effect.Effect<HostChangeOutcome, HostChangeApplyError>;
}
