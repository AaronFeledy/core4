import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LANDOFILE_NAME = ".lando.yml";

const isFile = async (path: string): Promise<boolean> => {
  const s = await stat(path).catch(() => undefined);
  return s?.isFile() === true;
};

export const findLandofilePath = async (cwd: string): Promise<string | undefined> => {
  let current = cwd;
  for (;;) {
    const candidate = join(current, LANDOFILE_NAME);
    if (await isFile(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

export const findAppRoot = async (cwd: string): Promise<string | undefined> => {
  const filePath = await findLandofilePath(cwd);
  if (filePath === undefined) return undefined;
  return dirname(filePath);
};
