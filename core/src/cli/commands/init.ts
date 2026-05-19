import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import { InitTargetExistsError } from "@lando/sdk/errors";
import { RecipeManifestService } from "@lando/sdk/services";

import { landofile, packageJson, serverJs } from "../../recipes/builtin/node-postgres/index.ts";
import {
  nodePostgresRecipeSource,
  nodePostgresRecipeYaml,
} from "../../recipes/builtin/node-postgres/manifest.ts";
import { RecipeManifestServiceLive } from "../../recipes/manifest/service.ts";

export interface InitAppOptions {
  readonly cwd: string;
  readonly full: boolean;
  readonly name?: string;
}

export interface InitAppResult {
  readonly appName: string;
  readonly directory: string;
}

const HARDCODED_FILE_RENDERERS: Record<string, (appName: string) => string> = {
  ".lando.yml": landofile,
  "package.json": packageJson,
  "server.js": () => serverJs,
};

const loadNodePostgresManifest = () =>
  Effect.runPromise(
    Effect.flatMap(RecipeManifestService, (svc) =>
      svc.parse(nodePostgresRecipeSource, nodePostgresRecipeYaml),
    ).pipe(Effect.provide(RecipeManifestServiceLive)),
  );

export const initApp = async ({ cwd, full, name }: InitAppOptions): Promise<InitAppResult> => {
  if (!full) {
    throw new Error("Missing required flag --full for the MVP built-in recipe.");
  }
  if (name === undefined || name.trim() === "") {
    throw new Error("Missing required flag --name.");
  }

  const manifest = await loadNodePostgresManifest();
  const files = manifest.files ?? [];
  if (files.length === 0) {
    throw new Error("Built-in node-postgres recipe is missing a files: manifest.");
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

  for (const file of files) {
    const renderer = HARDCODED_FILE_RENDERERS[file.dest];
    if (renderer === undefined) {
      throw new Error(
        `Built-in node-postgres recipe references an unknown destination "${file.dest}"; recipe rendering is not implemented yet.`,
      );
    }
    await writeFile(join(directory, file.dest), renderer(appName));
  }

  return { appName, directory };
};
