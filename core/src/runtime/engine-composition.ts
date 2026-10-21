import { resolveUserCacheRoot, resolveUserIncludesDir } from "@lando/engine/cache/paths";
import { type EngineCompositionInputs, installEngineCompositionIfAbsent } from "@lando/engine/composition";

import { httpJsonFetch } from "@lando/engine/services/json-fetch";
import { BUILT_IN_COMMAND_IDS } from "../cli/generated/command-ids";
import { resolveContainerHelper } from "../container-helper/assets";
import { defaultGitRecipeCloner, publish } from "../recipes/git-source";
import {
  DEFAULT_NPM_REGISTRY_URL,
  defaultNpmRegistryClient,
  makeNpmRecipeSourcePort,
} from "../recipes/npm-source";
import {
  defaultTarballRecipeExtractor,
  defaultTarballRecipeFetcher,
  makeTarballRecipeFetcher,
} from "../recipes/tarball-source";

export const baseEngineCompositionInputs: EngineCompositionInputs = {
  bundledPluginModules: [],
  builtInCommandIds: BUILT_IN_COMMAND_IDS,
  landofileSourcePorts: (client, downloader) => ({
    npmRecipeSource: makeNpmRecipeSourcePort(
      defaultNpmRegistryClient(DEFAULT_NPM_REGISTRY_URL, (url, options) =>
        httpJsonFetch(url, options, client),
      ),
    ),
    tarball: {
      fetch: makeTarballRecipeFetcher(downloader).fetch,
      extract: defaultTarballRecipeExtractor.extract,
    },
  }),
  landofileRuntimeInputs: {
    ports: {
      resolveUserCacheRoot,
      resolveUserIncludesDir,
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
  resolveContainerHelper,
};

installEngineCompositionIfAbsent(baseEngineCompositionInputs);
