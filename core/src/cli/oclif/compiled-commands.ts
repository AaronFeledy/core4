import { builtInCommandEntries } from "../built-in-command-registry";
import type { CommandClass } from "./metadata";

const compiledCommands = Object.fromEntries(
  builtInCommandEntries.map((entry) => [entry.spec.id, entry.command]),
) satisfies Record<string, CommandClass>;

export default compiledCommands;
