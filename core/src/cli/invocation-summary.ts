import { REDACTED } from "@lando/sdk/secrets";

const isFlag = (value: string): boolean => /^--?[a-z]/i.test(value);

const summarizeValue = (value: unknown): unknown => {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return `${REDACTED} (${value.length} values)`;
  return REDACTED;
};

export const summarizeInvocationRecord = (
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, summarizeValue(value)]));

export const summarizeInvocationArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const summary: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      const count = argv.length - index - 1;
      summary.push(argument);
      if (count > 0) summary.push(`${REDACTED} (${count} passthrough ${count === 1 ? "arg" : "args"})`);
      break;
    }

    const equalsIndex = argument.indexOf("=");
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (!isFlag(flag)) {
      summary.push(REDACTED);
      continue;
    }

    if (equalsIndex !== -1) {
      summary.push(`${flag}=${REDACTED}`);
      continue;
    }

    summary.push(flag);
    const value = argv[index + 1];
    if (value !== undefined && !isFlag(value)) {
      summary.push(REDACTED);
      index += 1;
    }
  }
  return summary;
};
