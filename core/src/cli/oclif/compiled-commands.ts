import { builtInCommandEntries } from "../built-in-command-registry.ts";
import type { CommandClass } from "./metadata.ts";

const compiledCommands = Object.fromEntries(
  builtInCommandEntries.map((entry) => [entry.spec.id, entry.command]),
) satisfies Record<string, CommandClass>;

export default compiledCommands;
