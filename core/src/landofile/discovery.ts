import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LANDOFILE_NAME = ".lando.yml";
export const LANDOFILE_TS_NAME = ".lando.ts";

const isFile = async (path: string): Promise<boolean> => {
  const s = await stat(path).catch(() => undefined);
  return s?.isFile() === true;
};

export const findLandofilePath = async (cwd: string): Promise<string | undefined> => {
  let current = cwd;
  for (;;) {
    const yamlCandidate = join(current, LANDOFILE_NAME);
    const typescriptCandidate = join(current, LANDOFILE_TS_NAME);
    if (await isFile(yamlCandidate)) return yamlCandidate;
    if (await isFile(typescriptCandidate)) return typescriptCandidate;
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
