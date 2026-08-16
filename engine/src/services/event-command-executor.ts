import { Context, type Effect } from "effect";

import type { EventCommandStep } from "@lando/sdk/schema";

export interface EventCommandExecutorInput {
  readonly step: EventCommandStep;
  readonly cwd: string;
}

interface EventCommandExecutorResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class EventCommandExecutor extends Context.Tag("@lando/engine/EventCommandExecutor")<
  EventCommandExecutor,
  {
    readonly run: (input: EventCommandExecutorInput) => Effect.Effect<EventCommandExecutorResult, unknown>;
  }
>() {}
