import { Effect, Layer } from "effect";
import type { CliInvocationContext } from "../runtime/invocation-context";
import { commandInputOptionError } from "./command-input-options";
import { commandSpecForId } from "./compiled-argv";
import { compiledCommandInputFromArgv } from "./compiled-input";
import { runCompiledCommand } from "./compiled-runtime";

export const rejectCommandCliArgValues = async (
  commandId: string,
  argv: readonly string[],
  context: CliInvocationContext,
): Promise<boolean> => {
  const definitions = Object.entries(commandSpecForId(commandId)?.args ?? {});
  if (!definitions.some(([, definition]) => definition.options !== undefined)) return false;
  const { args } = compiledCommandInputFromArgv(commandId, argv, { context });
  for (const [field, definition] of definitions) {
    const value = args[field];
    if (value === undefined) continue;
    for (const occurrence of definition.multiple === true && Array.isArray(value) ? value : [value]) {
      const error = commandInputOptionError(
        { target: commandId, kind: "arg", field },
        occurrence,
        definition.options,
      );
      if (error === undefined) continue;
      await runCompiledCommand(Effect.fail(error), Layer.empty, () => undefined, {
        context,
        preCommand: true,
        usage: true,
      });
      return true;
    }
  }
  return false;
};
