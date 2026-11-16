import { type EnvironmentDependencies, emptyEnvironmentDependencies } from "./environment-dependencies.ts";

export interface LandofileReferencedFile {
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

const referencedFiles = new WeakMap<object, ReadonlyArray<LandofileReferencedFile>>();

export const hasLandofileReferencedFiles = (landofile: object): boolean => referencedFiles.has(landofile);

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

const environmentDependencies = new WeakMap<object, EnvironmentDependencies>();

export const hasLandofileEnvironmentDependencies = (landofile: object): boolean =>
  environmentDependencies.has(landofile);

export const rememberLandofileEnvironmentDependencies = <A extends object>(
  landofile: A,
  dependencies: EnvironmentDependencies,
): A => {
  environmentDependencies.set(landofile, dependencies);
  return landofile;
};

export const getLandofileEnvironmentDependencies = (landofile: object): EnvironmentDependencies =>
  environmentDependencies.get(landofile) ?? emptyEnvironmentDependencies();
