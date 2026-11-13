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
