import { Context, type Effect, type Exit } from "effect";

export interface McpCommandExecution<A> {
  readonly commandId: string;
  readonly argv: ReadonlyArray<string>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  readonly successExitCode?: (value: A) => number | undefined;
}

export interface McpCommandExecutorShape {
  readonly execute: <A, E, R>(
    command: Effect.Effect<A, E, R>,
    execution: McpCommandExecution<A>,
  ) => Effect.Effect<Exit.Exit<A, E>, never, R>;
}

export class McpCommandExecutor extends Context.Tag("@lando/mcp/McpCommandExecutor")<
  McpCommandExecutor,
  McpCommandExecutorShape
>() {}
