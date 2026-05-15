import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { InitTargetExistsError } from "@lando/sdk/errors";

import { landofile, packageJson, serverJs } from "../../recipes/builtin/node-postgres/index.ts";

export interface InitAppOptions {
  readonly cwd: string;
  readonly full: boolean;
  readonly name?: string;
}

export interface InitAppResult {
  readonly appName: string;
  readonly directory: string;
}

export const initApp = async ({ cwd, full, name }: InitAppOptions): Promise<InitAppResult> => {
  if (!full) {
    throw new Error("Missing required flag --full for the MVP built-in recipe.");
  }
  if (name === undefined || name.trim() === "") {
    throw new Error("Missing required flag --name.");
  }

  const appName = name.trim();
  const directory = join(cwd, appName);
  const existing = await readdir(directory).catch((cause: unknown) => {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  });

  if (existing !== undefined && existing.length > 0) {
    throw new InitTargetExistsError({
      message: `Init target already exists and is not empty: ${directory}`,
      path: directory,
      remediation: "Choose an empty directory or wait for Alpha --force support.",
    });
  }

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".lando.yml"), landofile(appName));
  await writeFile(join(directory, "package.json"), packageJson(appName));
  await writeFile(join(directory, "server.js"), serverJs);

  return { appName, directory };
};
