import type { CompletedCommandResult } from "@lando/sdk/command-result";
import type { CommandCompletion } from "@lando/sdk/schema";
import { Context, type Effect, type Exit } from "effect";

export interface McpCommandExecution<A> {
  readonly commandId: string;
  readonly argv: ReadonlyArray<string>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly flags: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  readonly completion?: (value: A) => CommandCompletion;
}

export interface McpCommandExecutorShape {
  readonly execute: <A, E, R>(
    command: Effect.Effect<A, E, R>,
    execution: McpCommandExecution<A>,
  ) => Effect.Effect<Exit.Exit<CompletedCommandResult<A>, E>, never, R>;
}

export class McpCommandExecutor extends Context.Service<McpCommandExecutor, McpCommandExecutorShape>()(
  "@lando/mcp/McpCommandExecutor",
) {}
