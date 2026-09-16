const localIncludePaths = new WeakMap<object, ReadonlyArray<string>>();
const includeSources = new WeakMap<object, ReadonlyArray<LandofileIncludeSource>>();

export interface LandofileIncludeSource {
  readonly id: string;
  readonly sha256: string;
}

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

export const rememberLandofileIncludeSources = <T extends object>(
  landofile: T,
  sources: ReadonlyArray<LandofileIncludeSource>,
): T => {
  includeSources.set(
    landofile,
    [...new Map(sources.map((source) => [source.id, source])).values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  );
  return landofile;
};

export const getLandofileIncludeSources = (landofile: object): ReadonlyArray<LandofileIncludeSource> =>
  includeSources.get(landofile) ?? [];
