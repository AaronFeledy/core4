const localIncludePaths = new WeakMap<object, ReadonlyArray<string>>();

export const rememberLocalIncludePaths = <T extends object>(
  landofile: T,
  paths: ReadonlyArray<string>,
): T => {
  localIncludePaths.set(
    landofile,
    [...new Set(paths)].sort((left, right) => left.localeCompare(right)),
  );
  return landofile;
};

export const getLocalIncludePaths = (landofile: object): ReadonlyArray<string> =>
  localIncludePaths.get(landofile) ?? [];
