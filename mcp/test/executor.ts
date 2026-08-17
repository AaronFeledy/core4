import { Effect, Layer } from "effect";

import { McpCommandExecutor } from "@lando/mcp/port";

export const TestMcpCommandExecutor = Layer.succeed(McpCommandExecutor, {
  execute: (command) => Effect.exit(command),
});
