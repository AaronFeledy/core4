import type { Command } from "@oclif/core";

import { builtInCommandEntries } from "../built-in-command-registry.ts";

const compiledCommands = Object.fromEntries(
  builtInCommandEntries.map((entry) => [entry.spec.id, entry.command]),
) satisfies Record<string, Command.Class>;

export default compiledCommands;
