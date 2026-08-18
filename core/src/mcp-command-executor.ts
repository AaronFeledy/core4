import { type Context, Effect, type Exit, Layer } from "effect";

import { type McpCommandExecution, McpCommandExecutor, type McpCommandExecutorShape } from "@lando/mcp/port";
import { McpServiceLive as McpPackageServiceLive } from "@lando/mcp/service";
import { RedactionService } from "@lando/redaction/service";
import { makeNestedCommandInvocation, runCommandLifecycle } from "./cli/command-lifecycle";

const executeNestedCommand = <A, E, R>(
  redaction: Context.Tag.Service<typeof RedactionService>,
  command: Effect.Effect<A, E, R>,
  execution: McpCommandExecution<A>,
): Effect.Effect<Exit.Exit<A, E>, never, R> =>
  makeNestedCommandInvocation(execution.commandId, {
    argv: execution.argv,
    args: execution.args,
    flags: execution.flags,
    ...(execution.cwd === undefined ? {} : { cwd: execution.cwd }),
  }).pipe(
    Effect.flatMap((invocation) =>
      runCommandLifecycle(command, {
        invocation,
        ...(execution.successExitCode === undefined ? {} : { successExitCode: execution.successExitCode }),
      }),
    ),
    Effect.provideService(RedactionService, redaction),
  );

export const McpCommandExecutorLive: Layer.Layer<McpCommandExecutor, never, RedactionService> = Layer.effect(
  McpCommandExecutor,
  Effect.map(RedactionService, (redaction) => {
    const execute: McpCommandExecutorShape["execute"] = (command, execution) =>
      executeNestedCommand(redaction, command, execution);
    return { execute };
  }),
);

export const McpServiceLive = McpPackageServiceLive.pipe(Layer.provide(McpCommandExecutorLive));
