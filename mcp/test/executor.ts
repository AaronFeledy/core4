import { McpCommandExecutor } from "@lando/mcp/port";
import { resolveCommandCompletion } from "@lando/sdk/command-result";
import { Effect, Layer } from "effect";

export const TestMcpCommandExecutor = Layer.succeed(McpCommandExecutor, {
  execute: (command, execution) =>
    Effect.exit(
      command.pipe(
        Effect.map((value) => resolveCommandCompletion(execution.commandId, value, execution.completion)),
      ),
    ),
});
