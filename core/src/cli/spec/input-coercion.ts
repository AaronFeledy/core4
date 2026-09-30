export const specFlagsOf = (input: unknown): Record<string, unknown> => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("flags" in input) ||
    typeof input.flags !== "object" ||
    input.flags === null ||
    Array.isArray(input.flags)
  )
    return {};
  return Object.fromEntries(Object.entries(input.flags));
};

export const specArgsOf = (input: unknown): Record<string, unknown> => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("args" in input) ||
    typeof input.args !== "object" ||
    input.args === null ||
    Array.isArray(input.args)
  )
    return {};
  return Object.fromEntries(Object.entries(input.args));
};

export const stringFlag = (flags: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
};

export const booleanFlag = (flags: Readonly<Record<string, unknown>>, key: string): boolean =>
  flags[key] === true;

export const stringArrayFlag = (
  flags: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<string> => {
  const value = flags[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? [value]
      : [];
};

export const formatFlag = <T extends string>(
  flags: Readonly<Record<string, unknown>>,
  allowed: ReadonlyArray<T>,
  fallback: T,
): T => allowed.find((value) => value === flags.format) ?? fallback;
