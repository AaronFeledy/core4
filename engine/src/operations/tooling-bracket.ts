import { Effect } from "effect";

import type { LandofileEventName } from "@lando/sdk/schema";
import type { RuntimeProviderRegistry, ToolingEngine, ToolingEngineResult } from "@lando/sdk/services";

import type { EventRuntimeError } from "../tooling/event-errors.ts";
import { runAppEvent } from "./events.ts";
import {
  type ExecuteToolingInput,
  type ToolingExecutionError,
  executeToolingInvocations,
} from "./tooling-compile.ts";

const bracket = (lookupKey: string, position: "pre" | "post"): LandofileEventName =>
  `${position}-${lookupKey}` as LandofileEventName;

export interface BracketedInvocationsInput extends ExecuteToolingInput {
  /** Effective-tooling key the `pre-`/`post-` bracket names derive from. */
  readonly lookupKey: string;
}

/**
 * Runs compiled invocations between their `pre-<task>` and `post-<task>` brackets.
 *
 * Ordering follows command semantics: a failing pre bracket prevents the body, and a body
 * that exits non-zero prevents the post bracket while still returning its exit code as the
 * task result. Only top-level entry points bracket. An event `task:` step is an inline
 * invocation and calls `executeToolingInvocations` directly so it never re-brackets.
 */
export const runBracketedInvocations = (
  input: BracketedInvocationsInput,
): Effect.Effect<
  ToolingEngineResult,
  ToolingExecutionError | EventRuntimeError,
  ToolingEngine | RuntimeProviderRegistry
> =>
  Effect.gen(function* () {
    yield* runAppEvent(input.plan, bracket(input.lookupKey, "pre"));
    const result = yield* executeToolingInvocations(input);
    if (result.exitCode === 0) yield* runAppEvent(input.plan, bracket(input.lookupKey, "post"));
    return result;
  });
