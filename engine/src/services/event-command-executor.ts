import { Context, type Effect } from "effect";

export interface EventCommandExecutorInput {
  readonly command: string;
  readonly flags: Readonly<Record<string, string | number | boolean>>;
  readonly args: Readonly<Record<string, string | number | boolean>>;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly silent?: boolean;
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
