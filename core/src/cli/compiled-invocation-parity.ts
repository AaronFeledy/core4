/**
 * Compiled-dispatch argv parity validation.
 *
 * Validates compiled-mode argv against a command's flag/arg definitions so the
 * `$bunfs` dispatch path rejects the same invocations OCLIF would, with the same
 * exit-2 diagnostic wording. `rejectInvalidInvocation` is the dispatch guard;
 * `invocationParityError` is the pure diagnostic used by parity tests.
 */
import {
  argDefinitionsForCommand,
  commandSpecForId,
  flagDefinitionsForCommand,
  flagNameByToken,
} from "./compiled-argv.ts";
import { emitDiagnosticLine } from "./compiled-session.ts";

/**
 * Mirrors the consumption rules in `compiledCommandInputFromArgv`: a value flag
 * consumes the following token (even a `-`-prefixed one) as its value, and `--`
 * terminates flag parsing so everything after it is positional.
 */
export const flagTokenOf = (arg: string): string => {
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
};

export const invocationParityError = (commandId: string, argv: ReadonlyArray<string>): string | undefined => {
  const command = commandSpecForId(commandId);
  if (command === undefined) return undefined;
  const flagDefinitions = flagDefinitionsForCommand(command);
  const flagTokens = flagNameByToken(flagDefinitions);
  const maxPositionals = Object.keys(argDefinitionsForCommand(command)).length;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      for (let rest = index + 1; rest < argv.length; rest += 1) {
        const value = argv[rest];
        if (value !== undefined) positionals.push(value);
      }
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    const token = flagTokenOf(arg);
    const flagName = flagTokens.get(token);
    if (flagName === undefined) return `Nonexistent flag: ${token}`;
    const definition = flagDefinitions[flagName] ?? {};
    if (definition.type === "boolean") {
      if (equalsIndex !== -1) return `Unexpected argument: ${arg.slice(equalsIndex + 1)}`;
      continue;
    }
    if (equalsIndex !== -1) {
      const value = arg.slice(equalsIndex + 1);
      if (definition.options !== undefined && !definition.options.includes(value)) {
        return `Expected ${token}=${value} to be one of: ${definition.options.join(", ")}`;
      }
      continue;
    }
    const next = argv[index + 1];
    const nextIsFlag = next !== undefined && next !== "-" && flagTokens.has(flagTokenOf(next));
    if (next === undefined || nextIsFlag) {
      return definition.options === undefined
        ? `Flag ${token} expects a value`
        : `Flag ${token} expects one of these values: ${definition.options.join(", ")}`;
    }
    if (definition.options !== undefined && !definition.options.includes(next)) {
      return `Expected ${token}=${next} to be one of: ${definition.options.join(", ")}`;
    }
    index += 1;
  }
  const extra = positionals[maxPositionals];
  if (extra !== undefined) return `Unexpected argument: ${extra}`;
  return undefined;
};

export const rejectInvalidInvocation = (commandId: string, argv: ReadonlyArray<string>): boolean => {
  const diagnostic = invocationParityError(commandId, argv);
  if (diagnostic === undefined) return false;
  emitDiagnosticLine(diagnostic);
  process.exitCode = 2;
  return true;
};
