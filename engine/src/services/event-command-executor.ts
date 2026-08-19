import type { AppPlan } from "@lando/sdk/schema";
import { Context, type Effect } from "effect";

export interface EventCommandExecutorInput {
  readonly command: string;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly silent?: boolean;
  readonly plan?: AppPlan;
  readonly redactionTokens?: ReadonlyArray<string>;
}

interface EventCommandExecutorResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class EventCommandExecutor extends Context.Tag("@lando/engine/EventCommandExecutor")<
  EventCommandExecutor,
  {
    readonly validate?: (input: EventCommandExecutorInput) => Effect.Effect<void, unknown>;
    readonly run: (input: EventCommandExecutorInput) => Effect.Effect<EventCommandExecutorResult, unknown>;
  }
>() {}
