import { builtInCommandEntries } from "./built-in-command-registry";
import type { LandoCommandSpec } from "./spec/command-base";

const compiledCommands = Object.fromEntries(
  builtInCommandEntries.map((entry) => [entry.spec.id, entry.spec]),
) satisfies Record<string, LandoCommandSpec>;

export default compiledCommands;
