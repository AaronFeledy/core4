import { resolveUserCacheRoot } from "@lando/engine/cache/paths";
import { type EngineCompositionInputs, installEngineComposition } from "@lando/engine/composition";

import { BUILT_IN_COMMAND_IDS } from "../cli/generated/command-ids";
import { defaultGitRecipeCloner, publish } from "../recipes/git-source";
import { makeNpmRecipeSourcePort } from "../recipes/npm-source";
import { defaultTarballRecipeExtractor, defaultTarballRecipeFetcher } from "../recipes/tarball-source";

export const baseEngineCompositionInputs: EngineCompositionInputs = {
  bundledPluginModules: [],
  builtInCommandIds: BUILT_IN_COMMAND_IDS,
  landofileRuntimeInputs: {
    ports: {
      resolveUserCacheRoot,
      npmRecipeSource: makeNpmRecipeSourcePort(),
      git: defaultGitRecipeCloner,
      tarball: {
        fetch: defaultTarballRecipeFetcher.fetch,
        extract: defaultTarballRecipeExtractor.extract,
      },
      publication: { publish },
    },
    templates: { modules: [] },
  },
  hostProxyWorkerEntry: () => ({
    execPath: process.execPath,
    entryPath: process.argv[1],
    bunSourceEntryPath: new URL("../../bin/lando.ts", import.meta.url).pathname,
  }),
  bunDevDistRoot: () => new URL("../../dist", import.meta.url).pathname,
};

installEngineComposition(baseEngineCompositionInputs);
