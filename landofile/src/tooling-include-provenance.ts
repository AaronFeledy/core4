const internalToolingTasks = new WeakMap<object, ReadonlyArray<string>>();

export interface InternalToolingSource {
  readonly tooling: Readonly<Record<string, unknown>> | undefined;
  readonly internalTaskIds: ReadonlyArray<string>;
}

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

export const winningInternalToolingTasks = (
  sources: ReadonlyArray<InternalToolingSource>,
): ReadonlyArray<string> => {
  const winners = new Set<string>();
  for (const source of sources) {
    const internal = new Set(source.internalTaskIds);
    for (const id of Object.keys(source.tooling ?? {})) {
      if (internal.has(id)) winners.add(id);
      else winners.delete(id);
    }
  }
  return [...winners];
};
