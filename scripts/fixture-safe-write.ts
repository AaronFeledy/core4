import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type FixtureWriteFailure = "outside-root" | "symbolic-link" | "not-directory" | "not-file";

export interface FixtureWriteRequest {
  readonly trustedRoot: string;
  readonly fixturesRoot: string;
  readonly destination: string;
  readonly data: string | Uint8Array;
}

export class FixtureMaintenanceWriteError extends Error {
  override readonly name = "FixtureMaintenanceWriteError";

  constructor(
    readonly fixturesRoot: string,
    readonly destination: string,
    readonly failure: FixtureWriteFailure,
  ) {
    super(`Unsafe fixture maintenance write (${failure}): ${destination}`);
  }
}

const isMissingPathError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const lstatIfPresent = async (path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
};

export const writeFixtureFileSafely = async ({
  trustedRoot,
  fixturesRoot,
  destination,
  data,
}: FixtureWriteRequest): Promise<void> => {
  const trusted = resolve(trustedRoot);
  const root = resolve(fixturesRoot);
  const target = resolve(destination);
  const rootRelative = relative(trusted, root);
  const targetRelative = relative(root, target);
  if (
    rootRelative === ".." ||
    isAbsolute(rootRelative) ||
    rootRelative.startsWith(`..${sep}`) ||
    targetRelative === "" ||
    targetRelative === ".." ||
    isAbsolute(targetRelative) ||
    targetRelative.startsWith(`..${sep}`)
  ) {
    throw new FixtureMaintenanceWriteError(root, target, "outside-root");
  }

  let component = trusted;
  for (const segment of rootRelative === "" ? [] : rootRelative.split(sep)) {
    const componentStat = await lstatIfPresent(component);
    if (componentStat?.isSymbolicLink() === true) {
      throw new FixtureMaintenanceWriteError(root, target, "symbolic-link");
    }
    if (componentStat?.isDirectory() !== true) {
      throw new FixtureMaintenanceWriteError(root, target, "not-directory");
    }
    component = join(component, segment);
  }
  const rootStat = await lstatIfPresent(component);
  if (rootStat?.isSymbolicLink() === true) {
    throw new FixtureMaintenanceWriteError(root, target, "symbolic-link");
  }
  if (rootStat?.isDirectory() !== true) {
    throw new FixtureMaintenanceWriteError(root, target, "not-directory");
  }

  component = root;
  const parentRelative = relative(root, dirname(target));
  for (const segment of parentRelative === "" ? [] : parentRelative.split(sep)) {
    component = join(component, segment);
    const componentStat = await lstatIfPresent(component);
    if (componentStat === undefined) {
      await mkdir(component);
      continue;
    }
    if (componentStat.isSymbolicLink()) {
      throw new FixtureMaintenanceWriteError(root, target, "symbolic-link");
    }
    if (!componentStat.isDirectory()) {
      throw new FixtureMaintenanceWriteError(root, target, "not-directory");
    }
  }

  const destinationStat = await lstatIfPresent(target);
  if (destinationStat?.isSymbolicLink() === true) {
    throw new FixtureMaintenanceWriteError(root, target, "symbolic-link");
  }
  if (destinationStat !== undefined && !destinationStat.isFile()) {
    throw new FixtureMaintenanceWriteError(root, target, "not-file");
  }

  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
};
