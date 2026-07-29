const internalToolingTasks = new WeakMap<object, ReadonlyArray<string>>();

export const rememberInternalToolingTasks = <T extends object>(
  landofile: T,
  ids: ReadonlyArray<string>,
): T => {
  internalToolingTasks.set(
    landofile,
    [...new Set(ids)].sort((left, right) => left.localeCompare(right)),
  );
  return landofile;
};

export const getInternalToolingTasks = (landofile: object): ReadonlyArray<string> =>
  internalToolingTasks.get(landofile) ?? [];
