import { authoredInvocationSites } from "@lando/landofile/compiled-sites";
import { ToolingCompileError } from "@lando/sdk/errors";
import type { EventStep } from "@lando/sdk/schema";
import { Effect } from "effect";
import { EventStepCompileError, type EventStepIdentity, compileEventStepProgram } from "./step-compiler.ts";
import type { ToolingCommandStepLeaf, ToolingStepProgram } from "./step-program.ts";

export const compileAuthoredEventStepProgram = (
  steps: ReadonlyArray<EventStep>,
  validateCommand?: (leaf: ToolingCommandStepLeaf) => Effect.Effect<void, ToolingCompileError>,
  identities?: ReadonlyArray<EventStepIdentity>,
): Effect.Effect<ToolingStepProgram, EventStepCompileError> =>
  Effect.forEach(steps, (step, index) => {
    const identity = identities?.[index] ?? { authoredIndex: index };
    return Effect.try({
      try: () => ({ ...identity, invocationSites: authoredInvocationSites(step, "<event-step>") }),
      catch: (cause) => {
        const compileCause = new ToolingCompileError({
          message: cause instanceof Error ? cause.message : "Invalid authored invocation.",
          tool: typeof step !== "string" && "command" in step ? step.command : "event",
          cause,
        });
        return new EventStepCompileError({
          message: cause instanceof Error ? cause.message : "Invalid authored invocation.",
          authoredIndex: identity.authoredIndex,
          ...(identity.source === undefined ? {} : { source: identity.source }),
          kind:
            typeof step === "string"
              ? "cmd"
              : "command" in step
                ? "command"
                : "task" in step
                  ? "task"
                  : "cmd",
          cause: compileCause,
          remediation: compileCause.remediation,
        });
      },
    });
  }).pipe(Effect.flatMap((admitted) => compileEventStepProgram(steps, validateCommand, admitted)));
