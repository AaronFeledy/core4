export type ArgvFlagMatch = { readonly consumed: 0 | 1 } | undefined;

export const scanArgvFlags = (
  argv: ReadonlyArray<string>,
  match: (arg: string, next: string | undefined) => ArgvFlagMatch,
): string[] => {
  const remaining: string[] = [];
  let afterDoubleDash = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") afterDoubleDash = true;
    if (afterDoubleDash) {
      remaining.push(arg);
      continue;
    }
    const matched = match(arg, argv[index + 1]);
    if (matched === undefined) remaining.push(arg);
    else index += matched.consumed;
  }
  return remaining;
};

export const findArgvFlag = <T>(
  argv: ReadonlyArray<string>,
  probe: (arg: string, next: string | undefined) => T | undefined,
): T | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") break;
    const found = probe(arg, argv[index + 1]);
    if (found !== undefined) return found;
  }
  return undefined;
};
