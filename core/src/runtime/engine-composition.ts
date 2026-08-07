import { resolveUserCacheRoot } from "@lando/engine/cache/paths";
import { installEngineComposition } from "@lando/engine/composition";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";

import { BUILT_IN_COMMAND_IDS } from "../cli/generated/command-ids";
import { BUNDLED_PLUGIN_MODULES } from "../plugins/generated/bundled";
import { defaultGitRecipeCloner, publish } from "../recipes/git-source";
import { makeNpmRecipeSourcePort } from "../recipes/npm-source";
import { defaultTarballRecipeExtractor, defaultTarballRecipeFetcher } from "../recipes/tarball-source";

export const coreLandofileRuntimeInputs: LandofileRuntimeInputs = {
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
  templates: { modules: BUNDLED_PLUGIN_MODULES },
};

export const installCoreEngineComposition = (): void =>
  installEngineComposition({
    bundledPluginModules: BUNDLED_PLUGIN_MODULES,
    builtInCommandIds: BUILT_IN_COMMAND_IDS,
    landofileRuntimeInputs: coreLandofileRuntimeInputs,
    hostProxyWorkerEntry: () => ({
      execPath: process.execPath,
      entryPath: process.argv[1],
      bunSourceEntryPath: new URL("../../bin/lando.ts", import.meta.url).pathname,
    }),
    bunDevDistRoot: () => new URL("../../dist", import.meta.url).pathname,
  });

installCoreEngineComposition();
