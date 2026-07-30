export interface LandofileReferencedFile {
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

const referencedFiles = new WeakMap<object, ReadonlyArray<LandofileReferencedFile>>();

export const rememberLandofileReferencedFiles = <A extends object>(
  landofile: A,
  files: ReadonlyArray<LandofileReferencedFile>,
): A => {
  const unique = new Map(files.map((file) => [file.absolutePath, file]));
  referencedFiles.set(
    landofile,
    [...unique.values()].sort((left, right) => left.absolutePath.localeCompare(right.absolutePath)),
  );
  return landofile;
};

export const getLandofileReferencedFiles = (landofile: object): ReadonlyArray<LandofileReferencedFile> =>
  referencedFiles.get(landofile) ?? [];
